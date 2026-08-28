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

/** Current Vault state explicitly pulled by one live document session. */
export interface SecretViewState {
  secretId: SecretId;
  label: string;
  groupId: GroupId;
  groupName: string;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
  /** Present only when the current context is authorized for the group. */
  content?: string;
}

export type AuthorizationRevocationReason =
  | "idle-timeout"
  | "locked"
  | "lock-all"
  | "context-closed"
  | "vault-reloaded"
  | "password-changed"
  | "group-deleted"
  | "secret-deleted";

/**
 * Capability revocation is intentionally distinct from ordinary Vault change.
 *
 * Document references are clients, not replicas of Vault state. Normal data
 * mutations never push a refresh into document references. Only an authorization
 * boundary becoming invalid may proactively terminate an existing live session.
 */
export type AuthorizationRevocation =
  | { scope: "all"; reason: AuthorizationRevocationReason }
  | { scope: "context"; contextId: AccessContextId; reason: AuthorizationRevocationReason }
  | { scope: "group"; groupId: GroupId; reason: AuthorizationRevocationReason }
  | {
      scope: "context-group";
      contextId: AccessContextId;
      groupId: GroupId;
      reason: AuthorizationRevocationReason;
    }
  | { scope: "secret"; secretId: SecretId; reason: AuthorizationRevocationReason };
