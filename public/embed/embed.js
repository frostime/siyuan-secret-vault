const NS = "siyuan-secret-vault";
const V = 1;

const secretId = new URLSearchParams(location.search).get("secret") || "";
const pending = new Map();
const channel = new BroadcastChannel("siyuan-secret-vault:events");

let currentState = null;
let connected = false;
let editing = false;
let resizeQueued = false;

const el = {
  app: document.getElementById("app"),
  label: document.getElementById("label"),
  meta: document.getElementById("meta"),
  status: document.getElementById("status"),
  content: document.getElementById("content"),
  locked: document.getElementById("locked"),
  unlock: document.getElementById("unlock"),
  editor: document.getElementById("editor"),
  editLabel: document.getElementById("edit-label"),
  editContent: document.getElementById("edit-content"),
  save: document.getElementById("save"),
  cancel: document.getElementById("cancel"),
  error: document.getElementById("error"),
  actions: document.getElementById("actions"),
  edit: document.getElementById("edit"),
  copy: document.getElementById("copy"),
  lock: document.getElementById("lock"),
};

function request(type, data) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("插件未响应"));
    }, 2500);

    pending.set(requestId, {
      resolve,
      reject,
      timeout,
    });

    parent.postMessage({
      ns: NS,
      v: V,
      requestId,
      type,
      secretId,
      data,
    }, location.origin);
  });
}

function setError(message = "") {
  el.error.hidden = !message;
  el.error.textContent = message;
  queueFrameResize();
}

function queueFrameResize() {
  if (resizeQueued) return;
  resizeQueued = true;

  requestAnimationFrame(() => {
    resizeQueued = false;

    const frame = window.frameElement;
    if (!(frame instanceof HTMLIFrameElement)) return;

    const height = Math.max(
      112,
      Math.ceil(document.documentElement.scrollHeight + 2),
    );

    frame.style.height = `${height}px`;
  });
}

function exitEdit() {
  editing = false;
  el.editor.hidden = true;
  renderState(currentState);
}

function enterEdit() {
  if (!currentState || currentState.locked) return;

  editing = true;
  el.editLabel.value = currentState.label || "";
  el.editContent.value = currentState.content || "";

  el.content.hidden = true;
  el.locked.hidden = true;
  el.actions.hidden = true;
  el.editor.hidden = false;

  setTimeout(() => el.editContent.focus(), 0);
  queueFrameResize();
}

function renderState(state) {
  currentState = state;
  connected = true;

  el.app.classList.remove("state-loading", "state-unavailable");
  el.label.textContent = state.label || "Secret";
  el.meta.textContent = state.groupName || state.groupId || "";
  el.status.textContent = state.locked ? "🔒" : "🔓";

  if (editing) {
    queueFrameResize();
    return;
  }

  el.editor.hidden = true;
  el.actions.hidden = state.locked;
  el.locked.hidden = !state.locked;
  el.content.hidden = state.locked;
  el.content.textContent = state.locked ? "" : (state.content ?? "");

  queueFrameResize();
}

async function refresh() {
  try {
    const response = await request("secret:get-state");

    if (!response.ok) {
      throw new Error(response.error || "读取状态失败");
    }

    renderState(response.data);
    setError();
  } catch (error) {
    el.status.textContent = "!";
    setError(error.message || String(error));
  }
}

function shouldInvalidate(invalidation) {
  if (!invalidation || invalidation.scope === "all") return true;
  if (invalidation.scope === "none") return false;

  if (invalidation.scope === "secret") {
    return invalidation.secretId === secretId;
  }

  if (invalidation.scope === "group") {
    return currentState?.groupId === invalidation.groupId;
  }

  return true;
}

function handleInvalidate(message) {
  if (!shouldInvalidate(message.data)) return;

  editing = false;
  el.editor.hidden = true;
  el.content.textContent = "";

  void refresh();
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;

  const msg = event.data;
  if (!msg || msg.ns !== NS || msg.v !== V) return;

  if (msg.type === "invalidate") {
    handleInvalidate(msg);
    return;
  }

  if (msg.type !== "response" || !msg.requestId) return;

  const waiter = pending.get(msg.requestId);
  if (!waiter) return;

  pending.delete(msg.requestId);
  clearTimeout(waiter.timeout);
  waiter.resolve(msg);
});

channel.addEventListener("message", (event) => {
  const msg = event.data;

  if (
    !msg
    || msg.ns !== NS
    || msg.v !== V
    || msg.type !== "invalidate"
  ) {
    return;
  }

  handleInvalidate(msg);
});

window.addEventListener("beforeunload", () => {
  channel.close();
}, { once: true });

el.unlock.addEventListener("click", async () => {
  try {
    setError();

    const response = await request("secret:reveal");

    if (!response.ok) {
      throw new Error(response.error || "解锁失败");
    }

    await refresh();
  } catch (error) {
    setError(error.message || String(error));
  }
});

el.copy.addEventListener("click", async () => {
  try {
    setError();

    const response = await request("secret:copy");

    if (!response.ok) {
      throw new Error(response.error || "复制失败");
    }

    if (currentState?.locked) {
      await refresh();
    }
  } catch (error) {
    setError(error.message || String(error));
  }
});

el.edit.addEventListener("click", () => {
  enterEdit();
});

el.cancel.addEventListener("click", () => {
  exitEdit();
});

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

    if (!response.ok) {
      throw new Error(response.error || "保存失败");
    }

    editing = false;
    el.editor.hidden = true;

    await refresh();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    el.save.disabled = false;
  }
});

el.editContent.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter"
    && (event.ctrlKey || event.metaKey)
  ) {
    event.preventDefault();
    el.save.click();
  }
});

el.lock.addEventListener("click", async () => {
  try {
    const response = await request("secret:lock-group");

    if (!response.ok) {
      throw new Error(response.error || "锁定失败");
    }

    editing = false;
    await refresh();
  } catch (error) {
    setError(error.message || String(error));
  }
});

if (!secretId) {
  el.status.textContent = "!";
  setError("URL 中缺少 secret 参数");
  el.app.classList.add("state-unavailable");
} else {
  void refresh();

  setTimeout(() => {
    if (!connected) {
      el.status.textContent = "!";
      setError(
        "Secret Vault 主插件没有响应。此嵌入页不会自动重试。"
        + "重新启用插件或重新打开文档后再试。",
      );
      el.app.classList.add("state-unavailable");
    }
  }, 1300);
}
