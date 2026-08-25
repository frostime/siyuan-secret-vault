# SiYuan Secret Vault

[简体中文](README.zh-CN.md)

Secret Vault is a SiYuan plugin for storing sensitive text in password-protected groups and inserting interactive Secret references into documents. Secret content is encrypted before it is saved; labels remain plaintext so entries can be listed and searched.

## Features

- Organize Secrets into groups protected by independent passwords.
- Create, search, copy, edit, and delete Secrets from the built-in vault tab.
- Insert a Secret as a native SiYuan IFrame block from the vault or an editor slash command.
- Reveal, copy, edit, or lock a Secret directly from its document reference.
- Keep unlock state isolated between the vault and individual Protyle editors.
- Clear in-memory keys when an editor closes, after 15 minutes of inactivity, or when synchronized plugin data is reloaded.

## Requirements

- SiYuan 3.8.0 or later
- Desktop, browser-desktop, or desktop-window frontend

## Installation

This repository does not currently provide an automated marketplace installation. Build the plugin from source:

```bash
pnpm install
pnpm build
```

The build creates `dist/` and `package.zip`. Create the following directory inside the SiYuan workspace and extract the contents of `package.zip` into it:

```text
<workspace>/data/plugins/siyuan-secret-vault
```

Restart SiYuan or reload plugins, then enable **Secret Vault** in the plugin settings.

## Usage

### Manage Secrets

1. Select the lock icon in SiYuan's top bar to open the Secret Vault tab.
2. Create a group and choose its password. The default group asks for a password when it is first unlocked.
3. Unlock a group to create or manage its Secrets.
4. Keep sensitive information in **Content**. **Label** is plaintext metadata and should not contain confidential information.

Deleting a Secret does not remove existing document blocks. Those blocks remain as invalid references so the deletion is visible instead of silently removing document content.

### Insert a document reference

Use either method:

- Select **Insert into document** beside a Secret in the vault. The reference is inserted into the most recently active document editor.
- Type `/secret`, `/秘密`, or `/插入秘密` in an editor, then choose an existing Secret or create one from the dialog.

All Secret references in the same Protyle share that editor's group authorization. Unlocking one document does not unlock the vault or another document.

## Access Model

Unlock state is scoped to a UI context:

- The built-in vault is one context.
- Each live Protyle editor is a separate context.
- Each context/group authorization expires after 15 minutes without Secret access.
- Closing a Protyle immediately releases all authorizations held by that editor.
- Changing a group password revokes authorizations established with the previous password. The initiating context remains unlocked only if it is still active when the change is saved.

Passwords are never persisted. Derived AES keys are non-extractable `CryptoKey` objects held only in renderer memory while at least one authorized context needs them.

## Security Model

Secret Vault protects persisted and synchronized Secret content against inspection without the group password:

- Passwords are processed with PBKDF2-SHA-256 using a random salt per group.
- Content is encrypted with AES-256-GCM and authenticated against its group and Secret IDs.
- Stored data includes KDF parameters, password-verifier ciphertext, plaintext labels and group metadata, and encrypted content.

The plugin does not protect plaintext after the SiYuan renderer has been compromised. A malicious plugin, renderer XSS, clipboard monitor, or process with access to the running application may read an unlocked Secret. Forgotten passwords cannot be recovered.

## Data and Backups

Vault data is stored as `vault.json` through SiYuan's plugin data API. Document references store only the Secret identifier and public indexing attributes; encrypted content is not copied into document blocks.

Back up the workspace normally. Keep the vault data and documents together if references need to remain usable after restoration.

## Development

Start a watch build:

```bash
pnpm install
pnpm dev
```

The development build is written to `dev/`. Link or copy that directory to:

```text
<workspace>/data/plugins/siyuan-secret-vault
```

Useful commands:

```bash
pnpm check   # TypeScript and Svelte diagnostics
pnpm build   # production build and package.zip
```

Implementation boundaries and concurrency guarantees are documented in [ARCHITECTURE.md](ARCHITECTURE.md). Release history is available in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
