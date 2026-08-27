# Secret Vault Architecture

## 1. Core ownership rule

The document owns every Secret reference block.

A Secret reference is **not** a replica of Vault state and the Vault does not
push ordinary data changes into document blocks. The block decides when to ask
for Vault capabilities. The Vault owns only encrypted data, cryptographic keys,
authorization, and capability revocation.

Allowed directions:

```text
Document widget -> Vault request
Vault -> live-session revocation
```

Forbidden direction:

```text
Vault -> refresh/re-render/reconnect every document reference
```

This rule removes the old global invalidation/BroadcastChannel ownership model.

## 2. Persistent document representation

Version 3 references use SiYuan's native `NodeWidget` representation:

```html
<iframe src="/widgets/siyuan-secret-vault-widget" data-subtype="widget"></iframe>
```

Block attributes contain the authoritative Secret identity plus non-authoritative
presentation snapshots:

```text
custom-secret-vault=1
custom-secret-version=3
custom-secret-id=<authoritative Secret ID>
custom-secret-group=<group ID snapshot>
custom-secret-label=<label snapshot>
custom-secret-group-name=<group-name snapshot>
custom-secret-created-at=<timestamp snapshot>
custom-secret-updated-at=<timestamp snapshot>
```

`custom-secret-id` is the only authoritative reference identity. Snapshot fields
may be stale until a user explicitly reconnects or a future explicit snapshot
maintenance task is run.

## 3. Bundled widget deployment

The plugin ships an internal widget package under:

```text
public/bundled-widget/
```

At startup `BundledWidgetInstaller` checks:

```text
/data/widgets/siyuan-secret-vault-widget
```

through SiYuan `/api/file/*` APIs. If the directory is missing, the plugin
creates it and copies the bundled widget files. If the directory exists, the
plugin only fills missing managed files and does not overwrite a complete
installation.

This install-once policy is deliberate:

- `data/widgets` is normal SiYuan workspace data and participates in sync;
- two devices running different plugin versions must not continuously overwrite
  the synchronized widget package with different local versions;
- a future breaking widget update belongs in the explicit Migration Center, not
  in a hidden startup rewrite.

The widget is retained when the plugin is disabled or uninstalled because
existing document blocks depend on it for their dormant presentation.

## 4. Dormant widget state

Loading a document creates a normal SiYuan `NodeWidget`. Its widget script only
reads the containing block's snapshot attributes once and renders the dormant
card.

Dormant state does **not**:

- send `postMessage`;
- access the Vault;
- start a timer;
- poll;
- observe DOM mutations;
- open a MessageChannel;
- refresh when Vault data changes;
- reconnect when the plugin becomes ready.

The only transition to a live Vault client is an explicit user click on
`连接`.

## 5. Explicit live session

On explicit Connect:

```text
NodeWidget
  -> one window.postMessage(session:connect + transferred MessagePort)
  -> EmbedSessionBroker validates source block/context/secret ID
  -> dedicated MessagePort becomes the session transport
```

A live session owns:

```text
sessionId
secretId
groupId
contextId
blockId
source Window
MessagePort
```

Normal operations are user-driven requests on that port:

```text
secret:get-state
secret:reveal
secret:copy
secret:update
secret:lock-group
```

There is no BroadcastChannel and no ordinary parent-to-child refresh command.

## 6. Capability revocation

The one proactive parent-to-child action is revocation. Revocation is not UI
synchronization; it terminates a capability previously granted by the Vault.

Examples:

```text
idle timeout
manual group lock
context destruction
vault reload after official sync
password change
group deletion
secret deletion
plugin unload
```

On revocation, the widget must immediately:

```text
wipe plaintext
wipe edit buffers
reject pending operations
close MessagePort
show disconnected state
```

It never auto-reconnects.

## 7. Protyle context ownership

`ProtyleContextRegistry` owns only:

- `Protyle <-> AccessContextId` identity;
- one-time resolution of an explicitly connecting `NodeWidget` source window to
  its Protyle context and block ID;
- context release when a Protyle is destroyed.

It does not know Vault data and does not scan generic `NodeIFrame` references.
Once the MessagePort session is established, no further DOM lookup is required.

## 8. Vault and access ownership

`VaultController` owns committed persistent Vault state and the single-writer
mutation coordinator.

`GroupAccessManager` owns:

- runtime `CryptoKey` references;
- context-scoped group authorization;
- 15-minute inactivity timers;
- terminal context release.

Persistent mutations remain serialized over the complete clone -> crypto ->
persist -> commit lifecycle. `this.data` always represents the last successfully
persisted Vault snapshot.

## 9. Migration Center

Plugin startup never scans or rewrites user documents.

The Vault tab contains a permanent `数据与迁移` section. Version 0.5.0 exposes an
explicit migration task that converts v1/v2 Secret Vault generic IFrame blocks
to v3 `NodeWidget` blocks.

Migration properties:

- scan is read-only;
- execution is explicitly user-triggered;
- blocks are processed serially;
- `custom-secret-id` remains authoritative;
- v1 URL identity is used only as a consistency check;
- conflicts fail closed instead of guessing;
- original block IDs are retained;
- each converted block is re-read and verified;
- partial `markdown updated / attrs not updated` cases are retryable.

Legacy `/plugins/siyuan-secret-vault/embed/index.html` is kept only as a zero-JS
migration notice. It no longer connects to the Vault.

## 10. Height capability

`src/editor/secret-block-height.ts` contains the optional kernel-owned block
height capability. It uses block attributes and never mutates Protyle DOM.

The runtime integration edge is intentionally disconnected in 0.5.0. New v3
references receive one fixed initial height. Re-enabling dynamic height later
must be an explicit architecture decision and should use the isolated module,
not DOM measurement feedback spread across widget/session/Vault code.

## 11. Module ownership

```text
src/vault.ts
  committed encrypted Vault state and persistent mutation orchestration

src/access.ts
  runtime authorization, CryptoKey lifetime, inactivity timers

src/mutation-coordinator.ts
  global single-writer persistent mutation order

src/editor/secret-reference.ts
  canonical v3 NodeWidget reference representation and insertion

src/widget/bundled-widget-installer.ts
  install-once deployment of the document-owned widget package

src/editor/protyle-context.ts
  Protyle/context identity and one-time NodeWidget source resolution

src/embed/broker.ts + protocol.ts
  explicit live sessions and capability revocation

src/migrations/document-reference-to-widget.ts
  explicit v1/v2 -> v3 document migration

public/bundled-widget/*
  dormant presentation and explicit live client

public/embed/index.html
  zero-JS legacy migration notice only
```
