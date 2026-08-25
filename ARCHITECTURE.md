# Secret Vault architecture

## Security and access model

A group password is never persisted. Persisted data contains the PBKDF2 parameters,
verifier ciphertext, plaintext labels, and AES-GCM encrypted content.

Unlocking is scoped to an **access context**:

- `vault` — the built-in Secret Vault tab.
- `protyle:<uuid>` — one live Protyle editor instance.

A group key may be cached once in plugin memory, but a context may use it only after
that context has independently authenticated. Therefore:

- unlocking the Secret Vault does not unlock any document;
- unlocking document A does not unlock document B;
- all Secret frames inside the same Protyle share that Protyle's authorization;
- destroying a Protyle releases all of that Protyle's authorizations;
- when no context remains authorized for a group, the cached `CryptoKey` reference is released;
- each context/group authorization has an independent 15-minute inactivity timer;
- changing a group password keeps the initiating context authorized and revokes every other context.

## Module ownership

- `src/vault.ts` — persisted vault data, crypto orchestration, context-aware vault operations.
- `src/access.ts` — runtime keys, context authorization, inactivity timers, key lifetime.
- `src/crypto.ts` — PBKDF2 and AES-GCM primitives only.
- `src/embed/` — iframe protocol and broker; no Protyle lifecycle ownership.
- `src/editor/protyle-context.ts` — Protyle identity, iframe-to-Protyle resolution, session-local lazy resize.
- `src/editor/secret-reference.ts` — NodeIFrame insertion format, block attributes, slash-source cleanup.
- `src/editor/secret-dialogs.ts` — imperative SiYuan dialogs and unlock single-flight coordination.
- `src/ui/VaultApp.svelte` — built-in Vault UI bound to the `vault` access context.
- `src/index.ts` — composition root and SiYuan lifecycle registration.

## Embed invalidation and resize

Embed invalidation is deliberately scoped:

- `secret` — all references to one changed Secret;
- `context-group` — one group in one Protyle, used for normal lock/unlock/idle-lock;
- `group` — all contexts for a rare group-wide change such as password rotation;
- `all` — storage reload/synchronization.

Iframe height synchronization is intentionally **lazy**. Initial iframe loading and
background invalidation never resize Protyle blocks. Only explicit interaction inside
that iframe (unlock, edit, cancel, save, lock, retry, or an interaction-generated error)
may request a resize. The parent updates the live `NodeIFrame` and inner `<iframe>`
inline heights only; it does not persist resize state through kernel transactions.

There is no `setInterval`, `MutationObserver`, `ResizeObserver`, or recursive animation loop.
