// One-shot snapshot rendering only.
// No postMessage, timers, observers, polling, host-ready handling, or Vault access.
(() => {
  const label = document.getElementById("label");
  const meta = document.getElementById("meta");
  const connect = document.getElementById("connect");

  try {
    const frame = window.frameElement;
    const block = frame?.closest?.('[data-type="NodeIFrame"]');
    const secretId = block?.getAttribute?.("custom-secret-id")?.trim?.() || "";
    const secretLabel = block?.getAttribute?.("custom-secret-label")?.trim?.() || "";
    const groupName = block?.getAttribute?.("custom-secret-group-name")?.trim?.() || "";

    if (secretLabel) label.textContent = `🔐 ${secretLabel}`;
    if (groupName) meta.textContent = `${groupName} · 静态引用`;

    if (!secretId) {
      connect.removeAttribute("href");
      connect.setAttribute("aria-disabled", "true");
      connect.textContent = "引用缺少 ID";
    }
  } catch {
    // If the host DOM is not readable, keep the generic dormant presentation.
  }
})();
