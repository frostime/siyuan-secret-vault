# Secret Vault 0.6.0

Secret Vault stores encrypted Secret content in plugin data while document references remain inert SiYuan paragraph blocks.

A document reference contains only a plugin deep link and non-sensitive presentation snapshots. Opening a document does not create an iframe/widget runtime, request Vault data, poll, reconnect, or run per-reference code. Clicking the link explicitly opens one plugin-owned, non-modal popover anchored to the clicked link.

Before upgrading existing documents, open **Secret Vault → Data & Migration** and run the explicit v1/v2/v3 → v4 reference migration.
