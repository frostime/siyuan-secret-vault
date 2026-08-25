const NS = "siyuan-secret-vault";
const V = 1;
const secretId = new URLSearchParams(location.search).get("secret") || "";
const pending = new Map();
const channel = new BroadcastChannel("siyuan-secret-vault:events");
let connected = false;
let revealed = false;
let currentState = null;

const el = {
  app: document.getElementById("app"),
  label: document.getElementById("label"),
  group: document.getElementById("group"),
  status: document.getElementById("status"),
  content: document.getElementById("content"),
  error: document.getElementById("error"),
  reveal: document.getElementById("reveal"),
  copy: document.getElementById("copy"),
  lock: document.getElementById("lock"),
  open: document.getElementById("open"),
};

function request(type) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("插件未响应"));
    }, 2500);
    pending.set(requestId, { resolve, reject, timeout });
    parent.postMessage({ ns: NS, v: V, requestId, type, secretId }, location.origin);
  });
}

function setError(message = "") {
  el.error.hidden = !message;
  el.error.textContent = message;
}

function renderState(state) {
  currentState = state;
  connected = true;
  el.app.classList.remove("state-loading", "state-unavailable");
  el.label.textContent = state.label || "Secret";
  el.group.textContent = state.groupName ? `Group: ${state.groupName}` : "";
  el.status.textContent = state.locked ? "🔒 已锁定" : "🔓 已解锁";
  el.reveal.textContent = revealed ? "隐藏" : state.locked ? "解锁并显示" : "显示";
  el.lock.disabled = state.locked;
  if (state.locked) {
    revealed = false;
    el.content.hidden = true;
    el.content.textContent = "";
  }
}

async function refresh() {
  try {
    const response = await request("secret:get-state");
    if (!response.ok) throw new Error(response.error || "读取状态失败");
    renderState(response.data);
    setError();
  } catch (error) {
    el.status.textContent = "不可用";
    setError(error.message || String(error));
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.ns !== NS || msg.v !== V) return;
  if (msg.type === "invalidate") {
    revealed = false;
    el.content.hidden = true;
    el.content.textContent = "";
    void refresh();
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
  if (!msg || msg.ns !== NS || msg.v !== V || msg.type !== "invalidate") return;
  revealed = false;
  el.content.hidden = true;
  el.content.textContent = "";
  void refresh();
});
window.addEventListener("beforeunload", () => channel.close(), { once: true });

el.reveal.addEventListener("click", async () => {
  if (revealed) {
    revealed = false;
    el.content.hidden = true;
    el.content.textContent = "";
    el.reveal.textContent = currentState?.locked ? "解锁并显示" : "显示";
    return;
  }
  try {
    setError();
    const response = await request("secret:reveal");
    if (!response.ok) throw new Error(response.error || "无法显示");
    revealed = true;
    el.content.textContent = response.data?.content ?? "";
    el.content.hidden = false;
    el.reveal.textContent = "隐藏";
    await refresh();
  } catch (error) {
    setError(error.message || String(error));
  }
});

el.copy.addEventListener("click", async () => {
  try {
    setError();
    const response = await request("secret:copy");
    if (!response.ok) throw new Error(response.error || "复制失败");
    await refresh();
  } catch (error) {
    setError(error.message || String(error));
  }
});

el.lock.addEventListener("click", async () => {
  try {
    await request("secret:lock-group");
    revealed = false;
    el.content.hidden = true;
    el.content.textContent = "";
    await refresh();
  } catch (error) {
    setError(error.message || String(error));
  }
});

el.open.addEventListener("click", () => void request("secret:open-vault").catch(() => {}));

if (!secretId) {
  el.status.textContent = "无效引用";
  setError("URL 中缺少 secret 参数");
  el.app.classList.add("state-unavailable");
} else {
  void refresh();
  setTimeout(() => {
    if (!connected) {
      el.status.textContent = "插件未加载";
      setError("Secret Vault 主插件没有响应。此嵌入页不会自动重试。重新启用插件或重新打开文档后再试。");
      el.app.classList.add("state-unavailable");
    }
  }, 1300);
}
