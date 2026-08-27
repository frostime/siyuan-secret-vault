# Secret Vault Architecture — 0.4.x

## Decision pressure

The 0.4 architecture is optimized for one failure mode above all others: a Secret reference inside a SiYuan document must not become an always-on remote projection controlled by a process-wide Vault UI.

The 0.3 design made every NodeIFrame an active replica of Vault state. Vault mutations produced invalidations, invalidations were broadcast to every iframe, frames refreshed themselves, and presentation changes could feed back into SiYuan's NodeIFrame lifecycle. That design had three complexity symptoms:

- **Change amplification** — a Vault state change crossed VaultController, invalidation types, the broker, BroadcastChannel, iframe filtering, refresh, and presentation logic.
- **Cognitive load** — understanding one document block required understanding global Vault state, Protyle identity, broadcast fan-out, plugin lifecycle, iframe lifecycle, and resize behavior at once.
- **Unknown unknowns** — opening a document could trigger plugin work even when the user did nothing, making it difficult to reconstruct why an iframe refreshed or why SiYuan rerendered it.

The core ownership rule is therefore:

> **Document blocks are clients, not replicas of Vault state.**
>
> A Secret reference owns its presentation and decides when to connect. The Vault owns encrypted data, cryptography, authorization, and key lifetime. The Vault never pushes ordinary data changes into document references; it may only revoke a capability that it previously granted.

## Alternatives considered

Two decomposition axes were credible.

### A. Keep the realtime projection and add a lazy gate

The existing `Vault -> invalidation -> BroadcastChannel -> iframe refresh` graph could remain, with a boolean that delays activation until the iframe becomes visible or is clicked.

This is a small diff, but it preserves the leaked design knowledge: Vault still knows that document UI should refresh, every iframe still participates in global fan-out after activation, and the debug story still crosses the same modules. It reduces startup work without fixing ownership.

### B. Separate dormant references from explicit live sessions

The document owns an inert persisted reference. Only an explicit user action creates a temporary live client session. Each live session gets its own `MessagePort`. Ordinary Vault changes do not propagate to document blocks; capability revocation is a separate semantic channel.

This is a larger refactor, but it removes the dominant non-local control flow and gives each design decision one owner. 0.4 uses this model.

## State ownership

### `VaultController`

Owns:

- the last successfully persisted `VaultData`;
- crypto orchestration over that committed data;
- mutation serialization through `VaultMutationCoordinator`;
- snapshot publication for the built-in Vault UI;
- facts that an existing authorization capability has become invalid.

It does **not** own document rendering, iframe refresh, reconnect, or block presentation.

### `GroupAccessManager`

Owns:

- runtime-only `CryptoKey` references;
- context authorization;
- the 15-minute inactivity timer;
- context terminal lifecycle (a released context cannot be reactivated).

### `SecretReferenceService`

Owns the persistent SiYuan representation of one document reference.

New references use `custom-secret-version=2` and persist:

- `custom-secret-vault=1`;
- `custom-secret-id` — authoritative identity;
- `custom-secret-group`;
- `custom-secret-label` — display snapshot;
- `custom-secret-group-name` — display snapshot;
- `custom-secret-created-at` — display snapshot;
- `custom-secret-updated-at` — display snapshot.

Only `custom-secret-id` is authoritative. Snapshot metadata is intentionally allowed to become stale. Renaming a Secret in the Vault does not scan or rewrite documents.

The iframe `srcdoc` is also a snapshot owned by this module. It contains static HTML/CSS and an explicit `连接` link. It contains no script and performs no parent communication.

### `ProtyleContextRegistry`

Owns only:

- `Protyle -> AccessContextId` identity;
- Protyle lifecycle;
- one-time mapping from an explicitly connecting child `Window` to the containing NodeIFrame block and Protyle context.

It deliberately knows nothing about Secret Vault URL paths or protocol messages.

### `MigrationTask` / `LegacyReferenceV1ToV2Migration`

Own explicit, user-triggered maintenance transformations exposed by the Vault tab. Migration tasks own discovery, validation, sequential writes, verification, and retry semantics. The Vault UI only renders task state and progress.

The v1 -> v2 task treats `custom-secret-id` as authoritative, cross-checks legacy iframe identity, refuses conflicts instead of guessing, re-validates each block immediately before writing, and reuses `SecretReferenceService` to build the canonical v2 representation. No migration runs during plugin startup.

### `EmbedSessionBroker`

Owns temporary live iframe sessions.

One live session contains:

- session ID;
- Secret ID and Group ID;
- AccessContext ID;
- source block ID;
- source `Window`;
- one dedicated `MessagePort`;
- per-session request ordering.

The broker performs no iframe discovery, polling, BroadcastChannel fan-out, host-ready announcement, automatic refresh, or reconnect.

### `live.js`

Owns presentation state inside one explicitly connected iframe. It may request operations over its dedicated port only because the user first chose to connect that reference.

If a session is revoked it immediately deletes plaintext from the DOM, clears edit buffers, closes the port, and becomes disconnected. It never reconnects automatically.

## Dormant -> live control flow

### New v2 reference

```text
SiYuan opens document
    -> NodeIFrame srcdoc renders static snapshot
    -> no plugin request
    -> no Vault read
    -> no timer
    -> no BroadcastChannel

user clicks 连接
    -> iframe navigates itself to live.html?secret=<id>
    -> live page creates MessageChannel
    -> one window.postMessage(session:connect, transferred port)
    -> parent validates block attributes + Protyle context
    -> parent returns current state on the dedicated port
    -> explicit user operations continue on that port
```

The initial live connection is itself user-triggered. Loading the document is not a connection event.

### Legacy v1 reference

Existing v1 documents are never migrated automatically.

`public/embed/index.html` is a zero-JavaScript dormant compatibility shell. It does not parse query parameters, contact the parent plugin, connect to the Vault, or offer a live-session path. It only tells the user to open `秘密库 -> 数据与迁移`.

The Vault tab contains an explicit migration center. Its v1 -> v2 task performs a read-only SQL scan first, shows ready/problem counts, and only rewrites documents after the user confirms `开始迁移`. Blocks are processed serially and retain their existing block IDs.

Newly inserted references naturally use v2.

## Explicit operations

A connected iframe may explicitly request:

- `secret:get-state` — only from the user's Refresh action;
- `secret:reveal` — Unlock;
- `secret:copy` — Copy;
- `secret:update` — Save;
- `secret:lock-group` — Lock.

Normal `createSecret`, `updateSecret`, group rename, Vault-tab selection, plugin readiness, and snapshot publication do not push anything into document references.

Two live references to the same Secret are independent clients. Updating one does not automatically refresh the other.

## Capability revocation

Capability revocation is deliberately not called “invalidation”. It does not mean “please refresh”. It means “this live session may no longer retain or use the capability it was relying on”.

`VaultController` may publish revocation facts for:

- inactivity timeout;
- explicit group lock;
- lock-all;
- Protyle/context destruction;
- official-sync reload of `vault.json`;
- group password change;
- group deletion;
- Secret deletion.

`EmbedSessionBroker` matches only existing live sessions and sends `session:revoked`. The child then wipes plaintext and disconnects. It does not pull new data or reconnect.

Plugin unload is broker-owned and similarly revokes all currently live sessions with `plugin-stopping`. Dormant references are untouched.

## Sync behavior

`vault.json` remains in SiYuan's plugin data storage through `Plugin.saveData/loadData`.

`onDataChanged()` reloads committed Vault data, clears runtime grants, and revokes current live sessions. Dormant references do not refresh and are not rewritten. Their display metadata remains a snapshot until the user creates or explicitly refreshes a reference in a future feature.

## Height capability

Dynamic height is intentionally **disconnected in 0.4.x** while the dormant/live ownership model is validated.

`src/editor/secret-block-height.ts` contains an isolated kernel-owned implementation that:

- reads and writes block attributes through SiYuan kernel APIs;
- merges only the `height` declaration into an existing `style` value;
- clamps values;
- deduplicates near-identical writes;
- coalesces and serializes writes for one block;
- never mutates Protyle or iframe DOM directly.

The composition root intentionally does not instantiate or connect it. The commented integration marker in `src/index.ts` makes this decision explicit.

0.4.x therefore uses a fixed reference height and iframe-internal scrolling. Re-enabling height later must be an explicit document-presentation feature, not an automatic measurement feedback loop.

## Debug story

When a document is merely opened, there should be no Secret Vault runtime path to debug for a v2 reference.

When a user clicks Connect, the path is finite:

```text
live.js
  -> session:connect
  -> EmbedSessionBroker
  -> SecretReferenceService.matchesReference()
  -> ProtyleContextRegistry.resolveEmbed()
  -> VaultController.getSecretView()
  -> dedicated MessagePort
```

After connection, one iframe's requests remain on that port. There is no global event bus for document references.

If a live iframe unexpectedly clears, inspect an `AuthorizationRevocation` reason. If an ordinary Vault edit unexpectedly changes a dormant reference, that is an architecture violation.

## YAGNI cuts in 0.4.x

Not built or not enabled:

- automatic snapshot synchronization;
- BroadcastChannel;
- visibility observers;
- polling;
- automatic retries or reconnect;
- automatic host-ready refresh;
- automatic size measurement;
- dynamic block height integration;
- generic extension/event systems around live sessions.

These omissions are intentional. They keep the runtime surface small while the new ownership boundary is validated.

## Review invariants

Code review should reject a change unless deliberately justified if it introduces any of the following:

```text
Vault -> document refresh
Vault -> reconnect
Vault -> resize
ordinary Vault mutation -> iframe push
iframe load -> automatic Vault connection
background observer -> live session creation
plugin code -> direct NodeIFrame DOM mutation
```

Allowed directions are:

```text
Document/live session -> explicit Vault request
Vault/access boundary -> live session revoke
SecretReferenceService -> kernel-owned persistent block representation
```


## Migration center

Migration is a permanent maintenance surface in the Vault tab, not a startup side effect.

Allowed control flow:

```text
user opens 数据与迁移
    -> choose MigrationTask
    -> inspect()        # read-only
    -> preview
    -> explicit confirm
    -> run(preview)     # sequential kernel writes
    -> verify each block
```

A task must not duplicate the canonical representation it migrates to. The v1 -> v2 task calls `SecretReferenceService.buildDormantReference()` so insertion and migration cannot silently drift into different v2 formats.
