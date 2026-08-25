const NS = "siyuan-secret-vault";
const V = 1;

const FAST_TIMEOUT_MS = 8_000;
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;

const FRAME_HEIGHTS = {
  loading: 54,
  locked: 58,
  unlocked: 130,
  editing: 205,
  unavailable: 82,
};

const secretId = new URLSearchParams(location.search).get("secret") || "";
const pending = new Map();
const channel = new BroadcastChannel("siyuan-secret-vault:events");

let currentState = null;
let editing = false;
let currentMode = "loading";
let refreshPromise = null;

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

function getRequestTimeout(type) {
  switch (type) {
    case "secret:reveal":
    case "secret:copy":
    case "secret:update":
      // These operations can legitimately wait for the user to finish
      // entering a group password in the parent plugin dialog.
      return INTERACTIVE_TIMEOUT_MS;

    default:
      return FAST_TIMEOUT_MS;
  }
}

function request(type, data) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeoutMs = getRequestTimeout(type);

    const timeout = setTimeout(() => {
      pending.delete(requestId);

      reject(new Error(
        timeoutMs === INTERACTIVE_TIMEOUT_MS
          ? "操作等待超时"
          : "插件未响应",
      ));
    }, timeoutMs);

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

function setFrameHeight(mode = currentMode) {
  currentMode = mode;

  const frame = window.frameElement;
  if (!(frame instanceof HTMLIFrameElement)) return;

  let height = FRAME_HEIGHTS[mode] ?? FRAME_HEIGHTS.unlocked;

  if (!el.error.hidden) {
    height += 31;
  }

  // Do not derive height from scrollHeight/current iframe height.
  // That creates a positive feedback loop when the iframe viewport
  // itself participates in layout.
  frame.style.height = `${height}px`;
}

function setError(message = "", retryable = false) {
  el.error.hidden = !message;
  el.errorText.textContent = message;
  el.retry.hidden = !message || !retryable;
  setFrameHeight();
}

function setUnavailable(message) {
  editing = false;
  currentMode = "unavailable";

  el.app.classList.remove("state-loading");
  el.app.classList.add("state-unavailable");

  el.status.textContent = "!";
  el.meta.textContent = "连接失败";

  el.unlock.hidden = true;
  el.content.hidden = true;
  el.editor.hidden = true;
  el.actions.hidden = true;

  setError(message, true);
  setFrameHeight("unavailable");
}

function renderState(state) {
  currentState = state;

  el.app.classList.remove("state-loading", "state-unavailable");

  el.label.textContent = state.label || "Secret";
  el.meta.textContent = `${state.groupName || state.groupId || ""} · ${
    state.locked ? "已锁定" : "已解锁"
  }`;

  el.status.textContent = state.locked ? "🔒" : "🔓";

  if (editing) {
    setFrameHeight("editing");
    return;
  }

  el.editor.hidden = true;

  if (state.locked) {
    el.unlock.hidden = false;
    el.content.hidden = true;
    el.actions.hidden = true;
    el.content.textContent = "";

    setError();
    setFrameHeight("locked");
    return;
  }

  el.unlock.hidden = true;
  el.content.hidden = false;
  el.actions.hidden = false;
  el.content.textContent = state.content ?? "";

  setError();
  setFrameHeight("unlocked");
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
  setFrameHeight("editing");

  setTimeout(() => {
    el.editContent.focus();
    el.editContent.setSelectionRange(
      el.editContent.value.length,
      el.editContent.value.length,
    );
  }, 0);
}

function exitEdit() {
  editing = false;
  renderState(currentState);
}

async function performRefresh() {
  try {
    const response = await request("secret:get-state");

    if (!response.ok) {
      throw new Error(response.error || "读取状态失败");
    }

    renderState(response.data);
  } catch (error) {
    setUnavailable(error?.message || String(error));
  }
}

function refresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = performRefresh()
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

function shouldInvalidate(invalidation) {
  if (!invalidation || invalidation.scope === "all") {
    return true;
  }

  if (invalidation.scope === "none") {
    return false;
  }

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

  // Another reference may have modified this secret. Discard a stale
  // inline editor instead of letting it silently overwrite newer data.
  editing = false;
  el.editor.hidden = true;

  void refresh();
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;

  const msg = event.data;

  if (
    !msg
    || msg.ns !== NS
    || msg.v !== V
  ) {
    return;
  }

  if (msg.type === "invalidate") {
    handleInvalidate(msg);
    return;
  }

  if (
    msg.type !== "response"
    || !msg.requestId
  ) {
    return;
  }

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

  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
  }

  pending.clear();
}, { once: true });

el.retry.addEventListener("click", () => {
  el.app.classList.add("state-loading");
  el.app.classList.remove("state-unavailable");

  el.retry.disabled = true;
  el.meta.textContent = "重新连接中…";
  el.status.textContent = "•••";

  setError();
  setFrameHeight("loading");

  void refresh().finally(() => {
    el.retry.disabled = false;
  });
});

el.unlock.addEventListener("click", async () => {
  el.unlock.disabled = true;

  try {
    setError();

    const response = await request("secret:reveal");

    if (!response.ok) {
      throw new Error(response.error || "解锁失败");
    }

    await refresh();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    el.unlock.disabled = false;
  }
});

el.copy.addEventListener("click", async () => {
  el.copy.disabled = true;

  try {
    setError();

    const response = await request("secret:copy");

    if (!response.ok) {
      throw new Error(response.error || "复制失败");
    }
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    el.copy.disabled = false;
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
    setError(error?.message || String(error));
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
  el.lock.disabled = true;

  try {
    setError();

    const response = await request("secret:lock-group");

    if (!response.ok) {
      throw new Error(response.error || "锁定失败");
    }

    editing = false;
    await refresh();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    el.lock.disabled = false;
  }
});

if (!secretId) {
  setUnavailable("URL 中缺少 secret 参数");
  el.retry.hidden = true;
} else {
  setFrameHeight("loading");
  void refresh();
}
