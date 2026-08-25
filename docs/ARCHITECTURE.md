# Architecture

```text
SiYuan Plugin singleton
├── VaultController
│   ├── persisted VaultData
│   ├── Map<GroupId, CryptoKey>  (memory only)
│   └── AES-GCM / PBKDF2
├── Svelte 5 Vault tab
└── EmbedBroker
    ↑ postMessage, same origin
    ↓
NodeIFrame blocks
└── /plugins/siyuan-secret-vault/embed/index.html?secret=<id>
```

## Persistence

`label` is plaintext. `content` is independently AES-GCM encrypted with the currently unlocked group key. Passwords are never persisted.

## Failure behavior

The embed page sends a single request at initialization. If the plugin does not answer it switches to an unavailable state. There is no retry loop, polling timer or MutationObserver.

## Invalidation

The broker emits lightweight invalidation messages through `BroadcastChannel`. IFrame pages clear any revealed plaintext before refreshing state. The broker does not retain IFrame `Window` references, and there is no polling or DOM observer.
