const NS = "siyuan-secret-vault";
const V = 2;
const FAST_TIMEOUT_MS = 8_000;
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;
const HOST_UNAVAILABLE_MESSAGE = "秘密库插件未启用或当前不可用";

function readHostSecretId() {
  try {
    const frame = window.frameElement;
    const block = frame?.closest?.('[data-type="NodeIFrame"]');
    return block?.getAttribute?.("custom-secret-id")?.trim?.() || "";
  } catch {
    return "";
  }
}

const secretId = (new URLSearchParams(location.search).get("secret") || "").trim()
  || readHostSecretId();

let phase = "connecting";
let currentState = null;
let editing = false;
let sessionId = "";
let port = null;
let connectWaiter = null;
const pending = new Map();

const el = {
  app: document.getElementById("app"),
  label: document.getElementById("label"),
  meta: document.getElementById("meta"),
  status: document.getElementById("status"),
  timestamps: document.getElementById("timestamps"),
  content: document.getElementById("content"),
  unlock: document.getElementById("unlock"),
  editor: document.getElementById("editor"),
  editLabel: document.getElementById("edit-label"),
  editContent: document.getElementById("edit-content"),
  save: document.getElementById("save"),
  cancel: document.getElementById("cancel"),
  error: document.getElementById("error"),
  errorText: document.getElementById("error-text"),
  reconnect: document.getElementById("reconnect"),
  actions: document.getElementById("actions"),
  edit: document.getElementById("edit"),
  copy: document.getElementById("copy"),
  refresh: document.getElementById("refresh"),
  lock: document.getElementById("lock"),
};

function requestTimeout(type) {
  switch (type) {
    case "secret:reveal":
    case "secret:copy":
    case "secret:update":
      return INTERACTIVE_TIMEOUT_MS;
    default:
      return FAST_TIMEOUT_MS;
  }
}

function rejectPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  pending.clear();
}

function request(type, data) {
  if (phase !== "live" || !port) {
    return Promise.reject(new Error("当前 Secret 会话未连接"));
  }

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeoutMs = requestTimeout(type);
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(timeoutMs === INTERACTIVE_TIMEOUT_MS ? "操作等待超时" : HOST_UNAVAILABLE_MESSAGE));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timeout });
    port.postMessage({ type, requestId, data });
  });
}

function clearSensitiveState() {
  currentState = null;
  editing = false;
  el.content.textContent = "";
  el.editContent.value = "";
  el.editLabel.value = "";
  el.timestamps.textContent = "";
  el.timestamps.hidden = true;
  el.unlock.hidden = true;
  el.content.hidden = true;
  el.editor.hidden = true;
  el.actions.hidden = true;
}

function setError(message = "", reconnect = false) {
  el.error.hidden = !message;
  el.errorText.textContent = message;
  el.reconnect.hidden = !message || !reconnect;
}

function setLoading(message = "建立显式会话…") {
  clearSensitiveState();
  el.app.classList.add("state-loading");
  el.app.classList.remove("state-unavailable");
  el.label.textContent = "Secret";
  el.meta.textContent = message;
  el.status.textContent = "•••";
  setError();
}

function setDisconnected(message) {
  clearSensitiveState();
  phase = "disconnected";
  el.app.classList.remove("state-loading");
  el.app.classList.add("state-unavailable");
  el.label.textContent = "Secret Vault";
  el.meta.textContent = "会话未连接";
  el.status.textContent = "!";
  setError(message, Boolean(secretId));
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderState(state) {
  currentState = state;
  phase = "live";
  el.app.classList.remove("state-loading", "state-unavailable");
  el.label.textContent = state.label || "Secret";
  el.meta.textContent = `${state.groupName || state.groupId || ""} · ${state.locked ? "已锁定" : "本文档已解锁"}`;
  el.status.textContent = state.locked ? "🔒" : "🔓";

  const created = formatTime(state.createdAt);
  const updated = formatTime(state.updatedAt);
  el.timestamps.textContent = created || updated
    ? `创建 ${created || "—"} · 更新 ${updated || "—"}`
    : "";
  el.timestamps.hidden = !el.timestamps.textContent;

  if (editing) return;

  el.editor.hidden = true;
  if (state.locked) {
    el.unlock.hidden = false;
    el.content.hidden = true;
    el.actions.hidden = true;
    el.content.textContent = "";
    setError();
    return;
  }

  el.unlock.hidden = true;
  el.content.hidden = false;
  el.actions.hidden = false;
  el.content.textContent = state.content ?? "";
  setError();
}

function disconnectPort(sendDisconnect) {
  const activePort = port;
  port = null;

  if (activePort) {
    if (sendDisconnect) {
      try {
        activePort.postMessage({ type: "session:disconnect" });
      } catch {
        // The parent may already be gone.
      }
    }
    activePort.close();
  }
}

function settleConnect(ok, value) {
  if (!connectWaiter) return;
  clearTimeout(connectWaiter.timeout);
  const waiter = connectWaiter;
  connectWaiter = null;
  ok ? waiter.resolve(value) : waiter.reject(value);
}

function handleRevoked(reason) {
  const message = revocationMessage(reason);
  rejectPending(new Error(message));
  settleConnect(false, new Error(message));
  disconnectPort(false);
  setDisconnected(message);
}

function handlePortMessage(event) {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "session:connected") {
    if (message.sessionId !== sessionId) return;
    if (!message.ok || !message.state) {
      const error = new Error(message.error || HOST_UNAVAILABLE_MESSAGE);
      settleConnect(false, error);
      disconnectPort(false);
      setDisconnected(error.message);
      return;
    }

    settleConnect(true, message.state);
    renderState(message.state);
    return;
  }

  if (message.type === "session:revoked") {
    handleRevoked(message.reason || "revoked");
    return;
  }

  if (message.type !== "response" || !message.requestId) return;
  const waiter = pending.get(message.requestId);
  if (!waiter) return;

  pending.delete(message.requestId);
  clearTimeout(waiter.timeout);
  waiter.resolve(message);
}

function connect() {
  if (!secretId) {
    setDisconnected("当前文档块缺少 custom-secret-id");
    el.reconnect.hidden = true;
    return Promise.reject(new Error("当前文档块缺少 custom-secret-id"));
  }

  rejectPending(new Error("会话正在重新连接"));
  disconnectPort(true);
  setLoading();
  phase = "connecting";
  sessionId = crypto.randomUUID();

  const channel = new MessageChannel();
  port = channel.port1;
  port.addEventListener("message", handlePortMessage);
  port.start();

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!connectWaiter) return;
      connectWaiter = null;
      disconnectPort(false);
      const error = new Error(HOST_UNAVAILABLE_MESSAGE);
      setDisconnected(error.message);
      reject(error);
    }, FAST_TIMEOUT_MS);

    connectWaiter = { resolve, reject, timeout };
  });

  parent.postMessage({
    ns: NS,
    v: V,
    type: "session:connect",
    sessionId,
    secretId,
  }, location.origin, [channel.port2]);

  return promise;
}

function enterEdit() {
  if (!currentState || currentState.locked) return;

  editing = true;
  el.editLabel.value = currentState.label || "";
  el.editContent.value = currentState.content || "";
  el.unlock.hidden = true;
  el.content.hidden = true;
  el.actions.hidden = true;
  el.editor.hidden = false;
  setError();

  setTimeout(() => {
    el.editContent.focus();
    const end = el.editContent.value.length;
    el.editContent.setSelectionRange(end, end);
  }, 0);
}

function exitEdit() {
  editing = false;
  if (currentState) renderState(currentState);
}

function revocationMessage(reason) {
  switch (reason) {
    case "idle-timeout": return "授权已因长时间未使用而失效；点击重新连接";
    case "locked": return "当前分组已锁定；点击重新连接";
    case "lock-all": return "秘密库已锁定；点击重新连接";
    case "context-closed": return "当前文档会话已经结束";
    case "vault-reloaded": return "秘密库同步数据已更新；点击重新连接";
    case "password-changed": return "分组口令已变化；点击重新连接";
    case "group-deleted": return "秘密所属分组已删除";
    case "secret-deleted": return "秘密已删除";
    case "plugin-stopping": return "秘密库插件已停止";
    case "session-replaced": return "当前会话已被新的连接替换";
    default: return "Secret 会话已失效；点击重新连接";
  }
}

el.reconnect.addEventListener("click", () => {
  el.reconnect.disabled = true;
  void connect().catch(() => undefined).finally(() => {
    el.reconnect.disabled = false;
  });
});

el.unlock.addEventListener("click", async () => {
  el.unlock.disabled = true;
  try {
    setError();
    const response = await request("secret:reveal");
    if (!response.ok || !response.state) throw new Error(response.error || "解锁失败");
    renderState(response.state);
  } catch (error) {
    if (phase === "live") setError(error?.message || String(error));
  } finally {
    el.unlock.disabled = false;
  }
});

el.copy.addEventListener("click", async () => {
  el.copy.disabled = true;
  try {
    setError();
    const response = await request("secret:copy");
    if (!response.ok) throw new Error(response.error || "复制失败");
  } catch (error) {
    if (phase === "live") setError(error?.message || String(error));
  } finally {
    el.copy.disabled = false;
  }
});

el.refresh.addEventListener("click", async () => {
  el.refresh.disabled = true;
  try {
    setError();
    const response = await request("secret:get-state");
    if (!response.ok || !response.state) throw new Error(response.error || "刷新失败");
    editing = false;
    renderState(response.state);
  } catch (error) {
    if (phase === "live") setError(error?.message || String(error));
  } finally {
    el.refresh.disabled = false;
  }
});

el.edit.addEventListener("click", enterEdit);
el.cancel.addEventListener("click", exitEdit);

el.save.addEventListener("click", async () => {
  const label = el.editLabel.value.trim();
  if (!label) {
    setError("label 不能为空");
    el.editLabel.focus();
    return;
  }

  el.save.disabled = true;
  try {
    setError();
    const response = await request("secret:update", {
      label,
      content: el.editContent.value,
    });
    if (!response.ok || !response.state) throw new Error(response.error || "保存失败");

    editing = false;
    renderState(response.state);
  } catch (error) {
    if (phase === "live") setError(error?.message || String(error));
  } finally {
    el.save.disabled = false;
  }
});

el.editContent.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    el.save.click();
  }
});

el.lock.addEventListener("click", async () => {
  el.lock.disabled = true;
  try {
    setError();
    const response = await request("secret:lock-group");
    if (phase === "live" && !response.ok) throw new Error(response.error || "锁定失败");
  } catch (error) {
    // Successful lock normally revokes this session before a response arrives.
    if (phase === "live") setError(error?.message || String(error));
  } finally {
    el.lock.disabled = false;
  }
});

window.addEventListener("pagehide", () => {
  clearSensitiveState();
  rejectPending(new Error("页面已关闭"));
  settleConnect(false, new Error("页面已关闭"));
  disconnectPort(true);
}, { once: true });

if (!secretId) {
  setDisconnected("当前文档块缺少 custom-secret-id");
  el.reconnect.hidden = true;
} else {
  // This page is reachable only after an explicit user navigation from the
  // non-reactive dormant shell (or by opening a live URL directly). The
  // Secret ID is normally read from the host block's authoritative attribute.
  // That user action is the sole trigger for the one-time connection attempt.
  void connect().catch(() => undefined);
}
