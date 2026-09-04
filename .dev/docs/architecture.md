---
title: Secret Vault Architecture
description: v4 document reference architecture: dormant references, explicit popover interaction, authorization boundaries, and migration policy.
scope:
  - /src/vault.ts
  - /src/access.ts
  - /src/reference/**
  - /src/interaction/**
  - /src/migrations/**
  - /src/ui/**
updated: 2026-09-04
---

# Secret Vault Architecture — v4 document references

## 1. Design pressure

The dominant failure mode is not ordinary Vault CPU cost. Previous IFrame and
Widget references created an additional browsing context inside SiYuan's
Protyle lifecycle. Even after removing polling, BroadcastChannel, automatic
refresh, reconnect and dynamic resize, a document-resident iframe/widget still
expanded the host interaction surface and could participate in renderer-level
failure modes.

Version 0.6.0 therefore removes document-resident runtime entirely.

The architectural target is:

```text
open document
  -> ordinary NodeParagraph
  -> CSS presentation only
  -> no Secret Vault execution

explicit click
  -> SiYuan click-editorcontent captures Protyle + anchor
  -> open-siyuan-url-plugin confirms plugin-link intent
  -> validate paragraph custom-secret-id
  -> one plugin-owned non-modal popover
  -> explicit Vault operations
```

## 2. Core ownership rule

The document owns each persistent Secret reference. The Vault owns encrypted
Secret data, cryptographic keys, context authorization and revocation.

Allowed directions:

```text
explicit document click -> transient interaction -> Vault request
Vault authorization boundary -> transient interaction revocation
```

Forbidden directions:

```text
Vault -> refresh/re-render/reconnect all document references
Vault -> install runtime into every reference block
document open -> Secret decryption/request
```

A Secret reference is a client pointer, not a replica of Vault state.

## 3. Persistent v4 representation

A v4 reference is an ordinary SiYuan `NodeParagraph`:

```markdown
🔐 [Example Token](siyuan://plugins/siyuan-secret-vault/secret/sec_xxx) · default
```

Its block attributes are:

```text
custom-secret-vault=1
custom-secret-version=4
custom-secret-id=<authoritative Secret ID>
custom-secret-group=<group snapshot>
custom-secret-label=<label snapshot>
custom-secret-group-name=<group-name snapshot>
custom-secret-created-at=<timestamp snapshot>
custom-secret-updated-at=<timestamp snapshot>
```

`custom-secret-id` is the only authoritative Secret identity. The URL repeats
that ID only for routing. Before interaction, URL identity and block-attribute
identity must agree; conflicts fail closed.

The URL deliberately does not persist the SiYuan block ID. Copying a block gives
it a new block ID, so persisting the old one would create identity drift.

## 4. Dormant means no runtime

Opening a document containing v4 references performs no plugin work per
reference. A v4 block has:

```text
no iframe
no widget
no script
no postMessage / MessageChannel / BroadcastChannel
no timer
no observer
no polling
no Vault request
no CryptoKey
no plaintext
```

Presentation is a stylesheet rule matching `custom-secret-vault="1"` and
`custom-secret-version="4"`. The plugin never mounts UI inside a semantic
`[data-node-id]` block.

## 5. Explicit interaction adapter

SiYuan 3.8.0 was probed directly. For an editor plugin link the observed event
chain is:

```text
click-editorcontent
-> open-siyuan-url-plugin
```

`open-link` does not participate in this plugin-link path. Preventing the
original browser click does not suppress `open-siyuan-url-plugin`.

Responsibilities are therefore intentionally asymmetric:

- `click-editorcontent` captures the current Protyle, block ID and link geometry;
- `open-siyuan-url-plugin` is the authoritative plugin-link intent;
- a short-lived pending anchor correlates the two events;
- no native document click listener is required in production.

The pending anchor expires quickly and is never persisted.

## 6. Plugin-owned non-modal popover

At most one Secret popover exists. It is appended to `document.body`, uses
`position: fixed`, has no backdrop, and does not modify Protyle block DOM.

The popover owns only transient UI state:

```text
password input while submitting
plaintext view/edit buffer while authorized
one anchor rectangle
one Svelte component instance
```

Supported explicit operations are:

```text
unlock current group in current Protyle context
view multi-line Secret content
edit label/content
copy content
lock current group
close
```

Saving from a document popover first commits Vault data. It then explicitly
refreshes the clicked paragraph's non-sensitive snapshot. A snapshot refresh
failure does not roll back a successfully committed Secret; it is reported as a
separate presentation warning.

Opening a popover also revalidates the clicked paragraph's snapshot against
live Vault data (label, group name, timestamps). A stale snapshot is refreshed
in the background — the popover renders live data and never waits for the
write — with a non-blocking showMessage on success.

## 7. Authorization and revocation

`GroupAccessManager` remains the runtime owner of:

- in-memory `CryptoKey` references;
- Protyle-scoped group authorization;
- 15-minute inactivity timers;
- terminal context release.

Revocation reasons include idle timeout, manual lock, context destruction,
Vault reload after official sync, password change, group/Secret deletion and
plugin unload.

If a revocation matches the active popover, the popover is immediately
unmounted. No automatic reconnect exists.

## 8. Vault consistency

`VaultController` owns the last committed encrypted Vault state.
`VaultMutationCoordinator` serializes the complete staged mutation lifecycle:

```text
clone -> crypto -> Plugin.saveData -> commit in memory
```

Readers therefore never observe a half-committed password/KDF/ciphertext
mutation. Passwords are never persisted; derived `CryptoKey` objects remain in
memory only.

## 9. SiYuan boundary

Persistent document writes use SiYuan kernel APIs. Plugin data uses
`Plugin.loadData` / `Plugin.saveData`.

The plugin does not:

- directly edit `.sy` files;
- use Node/Electron filesystem access for workspace data;
- use MutationObserver to watch Protyle;
- scan all document references during normal runtime;
- perform runtime block-height synchronization.

## 10. Explicit migration

Startup never scans or rewrites user documents.

The permanent **数据与迁移** section exposes a v1/v2/v3 -> v4 task:

```text
v1 generic IFrame ----\
v2 dormant IFrame -----+-> v4 NodeParagraph
v3 native NodeWidget --/
```

Migration rules:

- scan is read-only;
- execution is explicitly user-triggered;
- blocks are processed serially;
- `custom-secret-id` remains authoritative;
- v1 URL identity is only a consistency check;
- unknown/conflicting formats fail closed;
- original block IDs are retained;
- legacy fixed height is removed while unrelated style declarations are kept;
- every converted block is re-read and verified;
- a system-level format/API mismatch stops the remaining batch.

The legacy `/plugins/siyuan-secret-vault/embed/index.html` is retained only as a
zero-JS migration notice for old IFrame documents. Existing workspace widget
files are not deleted automatically because old v3 documents may still depend
on them until the user finishes migration.

## 11. Module ownership

```text
src/vault.ts
  committed encrypted Vault state and persistent mutation orchestration

src/access.ts
  runtime CryptoKey lifetime, context authorization and idle timers

src/mutation-coordinator.ts
  global single-writer persistent mutation order

src/reference/secret-reference.ts
  canonical v4 paragraph/link/attribute format, insertion and verification

src/interaction/editor-context.ts
  Protyle <-> AccessContextId identity and insertion target tracking

src/interaction/secret-interaction.ts
  plugin-link event correlation, reference validation and popover lifecycle

src/ui/workbench.svelte.ts
  VaultWorkbench class-store: workspace state ($state/$derived) and all
  workspace behavior; components are thin views over this instance

src/ui/VaultApp.svelte
  workspace root: workbench assembly, three-column layout, dialogs

src/ui/GroupSidebar.svelte / SecretList.svelte / SecretDetail.svelte /
  MigrationWorkspace.svelte / Modal.svelte
  view components with scoped styles; Modal is the shared dialog shell

src/interaction/SecretPopover.svelte
  transient unlock/view/edit/copy UI only

src/editor/secret-dialogs.ts
  slash-command create/picker flows; not document-reference runtime

src/siyuan/api.ts
  small typed kernel HTTP boundary used by reference/migration code

src/migrations/reference-to-paragraph.ts
  explicit v1/v2/v3 -> v4 migration policy
```

## 12. Deliberate YAGNI cuts

The Vault intentionally does not build:

- a generic popover framework;
- runtime reference synchronization;
- automatic reference snapshot maintenance;
- per-reference lifecycle objects;
- a kernel plugin;
- dynamic reference height management;
- document-wide DOM observers;
- compatibility MessageChannel/Broker layers;
- automatic deletion of legacy widget files.

These cuts keep the normal document-open path equivalent to an ordinary
paragraph plus CSS, which is the primary reliability objective of this version.
