export type GroupId = string;
export type SecretId = string;

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
  focusedSecretId: SecretId | null;
}
