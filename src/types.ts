export type GroupId = string;
export type SecretId = string;

/**
 * Access is scoped to a UI context, not to the whole plugin process.
 *
 * `vault` is the built-in Secret Vault tab. Every Protyle gets its own
 * `protyle:<uuid>` context, so unlocking one editor never unlocks another.
 */
export type AccessContextId = "vault" | `protyle:${string}`;
export const VAULT_CONTEXT_ID: AccessContextId = "vault";

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

export interface GroupKdf {
  algorithm: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  salt: string;
}

export interface SecretGroup {
  id: GroupId;
  name: string;
  createdAt: number;
  updatedAt: number;
  kdf: GroupKdf;
  verifier: EncryptedPayload | null;
}

export interface SecretRecord {
  id: SecretId;
  groupId: GroupId;
  label: string;
  encryptedContent: EncryptedPayload;
  createdAt: number;
  updatedAt: number;
}

export interface VaultData {
  schemaVersion: 1;
  groups: SecretGroup[];
  secrets: SecretRecord[];
}

export interface PublicGroupState {
  id: GroupId;
  name: string;
  initialized: boolean;
  /** Whether this group is unlocked in the snapshot's access context. */
  unlocked: boolean;
  secretCount: number;
}

export interface PublicSecretState {
  id: SecretId;
  groupId: GroupId;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultSnapshot {
  revision: number;
  groups: PublicGroupState[];
  secrets: PublicSecretState[];
}

export interface SecretViewState {
  contextId: AccessContextId;
  secretId: SecretId;
  label: string;
  groupId: GroupId;
  groupName: string;
  locked: boolean;
  /** Present only when the current context is authorized for the group. */
  content?: string;
}

/**
 * Events sent to embedded Secret frames. Snapshot/UI refresh is separate from
 * this type so UI-only changes cannot accidentally fan out to every iframe.
 */
export type VaultInvalidation =
  | { scope: "all" }
  | { scope: "group"; groupId: GroupId }
  | { scope: "context-group"; contextId: AccessContextId; groupId: GroupId }
  | { scope: "secret"; secretId: SecretId };
