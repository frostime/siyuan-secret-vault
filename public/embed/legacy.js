const secretId = new URLSearchParams(location.search).get("secret") || "";
const connect = document.getElementById("connect");
const error = document.getElementById("error");

if (secretId) {
  connect.href = `./live.html?secret=${encodeURIComponent(secretId)}`;
  connect.removeAttribute("aria-disabled");
} else {
  connect.removeAttribute("href");
  connect.setAttribute("aria-disabled", "true");
  error.hidden = false;
}
