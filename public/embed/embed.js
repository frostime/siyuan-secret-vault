const NS = "siyuan-secret-vault";
const V = 1;

const FAST_TIMEOUT_MS = 8_000;
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;

const secretId = new URLSearchParams(location.search).get("secret") || "";
const pending = new Map();
const channel = new BroadcastChannel("siyuan-secret-vault:events");

let currentState = null;
let editing = false;
let refreshPromise = null;
let resizeScheduled = false;

const el = {
  app: document.getElementById("app"),
  label: document.getElementById("label"),
  meta: document.getElementById("meta"),
  status: document.getElementById("status"),
  content: document.getElementById("content"),
  unlock: document.getElementById("unlock"),
  editor: document.getElementById("editor"),
  editLabel: document.getElementById("edit-label"),
  editContent: document.getElementById("edit-content"),
  save: document.getElementById("save"),
  cancel: document.getElementById("cancel"),
  error: document.getElementById("error"),
  errorText: document.getElementById("error-text"),
  retry: document.getElementById("retry"),
  actions: document.getElementById("actions"),
  edit: document.getElementById("edit"),
  copy: document.getElementById("copy"),
  lock: document.getElementById("lock"),
};

function requestTimeout(type) {
  switch (type) {
    case "secret:reveal":
    case "secret:copy":
    case "secret:update":
      // These requests may wait while the parent plugin shows a password dialog.
      return INTERACTIVE_TIMEOUT_MS;
    default:
      return FAST_TIMEOUT_MS;
  }
}

function request(type, data) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeoutMs = requestTimeout(type);
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(
        timeoutMs === INTERACTIVE_TIMEOUT_MS
          ? "操作等待超时"
          : "插件未响应",
      ));
    }, timeoutMs);

    pending.set(requestId, { resolve, timeout });
    parent.postMessage({ ns: NS, v: V, requestId, type, secretId, data }, location.origin);
  });
}

/**
 * Resize is deliberately interaction-driven. Initial load and background
 * invalidation never call this function. The parent persists the requested
 * height through SiYuan's block-attribute API; this frame never edits Protyle
 * DOM directly.
 */
function requestFrameResize() {
  if (resizeScheduled) return;
  resizeScheduled = true;

  requestAnimationFrame(() => {
    resizeScheduled = false;

    const bodyStyle = getComputedStyle(document.body);
    const paddingTop = Number.parseFloat(bodyStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(bodyStyle.paddingBottom) || 0;
    const height = Math.ceil(
      el.app.getBoundingClientRect().height
      + paddingTop
      + paddingBottom
      + 2,
    );

    parent.postMessage({
      ns: NS,
      v: V,
      type: "embed:resize",
      secretId,
      height,
    }, location.origin);
  });
}

function setError(message = "", retryable = false) {
  el.error.hidden = !message;
  el.errorText.textContent = message;
  el.retry.hidden = !message || !retryable;
}

function setUnavailable(message) {
  editing = false;
  el.app.classList.remove("state-loading");
  el.app.classList.add("state-unavailable");
  el.status.textContent = "!";
  el.meta.textContent = "连接失败";
  el.unlock.hidden = true;
  el.content.hidden = true;
  el.editor.hidden = true;
  el.actions.hidden = true;
  setError(message, true);
}

function renderState(state) {
  currentState = state;
  el.app.classList.remove("state-loading", "state-unavailable");
  el.label.textContent = state.label || "Secret";
  el.meta.textContent = `${state.groupName || state.groupId || ""} · ${
    state.locked ? "已锁定" : "本文档已解锁"
  }`;
  el.status.textContent = state.locked ? "🔒" : "🔓";

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

async function performRefresh() {
  try {
    const response = await request("secret:get-state");
    if (!response.ok) throw new Error(response.error || "读取状态失败");
    renderState(response.data);
  } catch (error) {
    setUnavailable(error?.message || String(error));
  }
}

function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = performRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
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
  requestFrameResize();

  setTimeout(() => {
    el.editContent.focus();
    const end = el.editContent.value.length;
    el.editContent.setSelectionRange(end, end);
  }, 0);
}

function exitEdit() {
  editing = false;
  renderState(currentState);
  requestFrameResize();
}

function shouldInvalidate(invalidation) {
  if (!invalidation || invalidation.scope === "all") return true;

  if (invalidation.scope === "secret") {
    return invalidation.secretId === secretId;
  }

  if (invalidation.scope === "group") {
    return currentState?.groupId === invalidation.groupId;
  }

  if (invalidation.scope === "context-group") {
    return currentState?.contextId === invalidation.contextId
      && currentState?.groupId === invalidation.groupId;
  }

  return false;
}

function handleInvalidation(invalidation) {
  if (!shouldInvalidate(invalidation)) return;

  // Background changes never resize the outer NodeIFrame. This is intentional:
  // only a direct user interaction in this frame may trigger a layout write.
  editing = false;
  el.editor.hidden = true;
  void refresh();
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;

  const message = event.data;
  if (!message || message.ns !== NS || message.v !== V) return;

  if (message.type === "invalidate") {
    handleInvalidation(message.invalidation);
    return;
  }

  if (message.type !== "response" || !message.requestId) return;

  const waiter = pending.get(message.requestId);
  if (!waiter) return;

  pending.delete(message.requestId);
  clearTimeout(waiter.timeout);
  waiter.resolve(message);
});

channel.addEventListener("message", (event) => {
  const message = event.data;
  if (
    !message
    || message.ns !== NS
    || message.v !== V
    || message.type !== "invalidate"
  ) {
    return;
  }
  handleInvalidation(message.invalidation);
});

window.addEventListener("beforeunload", () => {
  channel.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timeout);
  pending.clear();
}, { once: true });

el.retry.addEventListener("click", () => {
  el.app.classList.add("state-loading");
  el.app.classList.remove("state-unavailable");
  el.retry.disabled = true;
  el.meta.textContent = "重新连接中…";
  el.status.textContent = "•••";
  setError();

  void refresh().finally(() => {
    el.retry.disabled = false;
    requestFrameResize();
  });
});

el.unlock.addEventListener("click", async () => {
  el.unlock.disabled = true;
  try {
    setError();
    const response = await request("secret:reveal");
    if (!response.ok) throw new Error(response.error || "解锁失败");
    await refresh();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    el.unlock.disabled = false;
    requestFrameResize();
  }
});

el.copy.addEventListener("click", async () => {
  el.copy.disabled = true;
  try {
    setError();
    const response = await request("secret:copy");
    if (!response.ok) throw new Error(response.error || "复制失败");
  } catch (error) {
    setError(error?.message || String(error));
    requestFrameResize();
  } finally {
    el.copy.disabled = false;
  }
});

el.edit.addEventListener("click", enterEdit);
el.cancel.addEventListener("click", exitEdit);

el.save.addEventListener("click", async () => {
  const label = el.editLabel.value.trim();
  if (!label) {
    setError("label 不能为空");
    el.editLabel.focus();
    requestFrameResize();
    return;
  }

  el.save.disabled = true;
  try {
    setError();
    const response = await request("secret:update", {
      label,
      content: el.editContent.value,
    });
    if (!response.ok) throw new Error(response.error || "保存失败");

    editing = false;
    el.editor.hidden = true;
    await refresh();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    el.save.disabled = false;
    requestFrameResize();
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
    if (!response.ok) throw new Error(response.error || "锁定失败");

    editing = false;
    await refresh();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    el.lock.disabled = false;
    requestFrameResize();
  }
});

if (!secretId) {
  setUnavailable("URL 中缺少 secret 参数");
  el.retry.hidden = true;
} else {
  // Initial state is deliberately resize-free. Large documents can instantiate
  // many frames at once, and the outer NodeIFrame is only resized after a user
  // explicitly changes this frame's UI.
  void refresh();
}
