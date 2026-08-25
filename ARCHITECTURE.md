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
- a released Protyle context is terminal and can never be authorized again;
- when no context remains authorized for a group, the cached `CryptoKey` reference is released;
- each context/group authorization has an independent 15-minute inactivity timer;
- changing a group password keeps the initiating context authorized only if it is still authorized when the save commits, and revokes every other context.

## Persistent-state consistency

`vault.json` has one logical writer. `VaultMutationCoordinator` serializes the **whole
mutation lifecycle**, not merely calls to `saveData`:

1. observe and validate the last committed vault state;
2. clone it into a detached staged state;
3. perform any asynchronous crypto against that staged state;
4. re-check runtime authorization when an operation may have outlived its context;
5. persist the complete staged snapshot;
6. replace the in-memory committed state only after persistence succeeds;
7. update related runtime authorization and publish invalidation before the queue advances.

Consequences:

- password rotation cannot interleave with Secret encryption using an old key;
- two contexts cannot initialize an uninitialized group with competing passwords;
- a failed persistence never requires a partial in-memory rollback and cannot leak into a later queued snapshot;
- readers always see the last successfully persisted `VaultData`, never a half-committed KDF/ciphertext transition.

The queue is intentionally global rather than per-group because all groups share one
persisted `vault.json` snapshot. Write throughput is not a design goal for this plugin;
simple ordering and recoverable state are.

## Module ownership

- `src/vault.ts` — committed vault data, crypto orchestration, context-aware vault operations.
- `src/mutation-coordinator.ts` — single-writer ordering for complete persistent mutation lifecycles.
- `src/access.ts` — runtime keys, active/released context lifecycle, authorization, inactivity timers, key lifetime.
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
