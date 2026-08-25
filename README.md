# SiYuan Secret Vault

Svelte 5 based SiYuan plugin prototype for group-specific encrypted secrets and interactive document IFrame references.

See [README.zh-CN.md](README.zh-CN.md) for design, security boundaries, development and validation notes.

## v0.1.1 interaction entry points

- Open the Vault custom tab from the top bar.
- Type `/secret` (or Chinese aliases such as `/秘密`) in an editor to search and insert a Secret IFrame reference at the active editor position.
- The Custom Tab ID follows SiYuan's required `plugin.name + TAB_TYPE` convention.

## 0.1.2 insertion fix

Document insertion now consumes the active slash query first, creates a real IFrame block through the kernel block API, and writes `custom-secret-*` attributes in a separate attribute call. The slash menu also supports creating a new secret directly in the current document before inserting it.
