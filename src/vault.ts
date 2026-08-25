import type { Plugin } from "siyuan";
import {
  createKdf,
  createVerifier,
  decryptSecretContent,
  deriveGroupKey,
  encryptSecretContent,
  verifyGroupKey,
} from "./crypto";
import type {
  GroupId,
  SecretGroup,
  SecretId,
  SecretRecord,
  VaultData,
  VaultSnapshot,
} from "./types";

const STORAGE_FILE = "vault.json";
const DEFAULT_GROUP_ID = "default";

function makeDefaultGroup(): SecretGroup {
  const now = Date.now();
  return {
    id: DEFAULT_GROUP_ID,
    name: "default",
    createdAt: now,
    updatedAt: now,
    kdf: createKdf(),
    verifier: null,
  };
}

function emptyVault(): VaultData {
  return { schemaVersion: 1, groups: [makeDefaultGroup()], secrets: [] };
}

function cloneVault(data: VaultData): VaultData {
  return structuredClone(data);
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class VaultController {
  private data: VaultData = emptyVault();
  private unlockedKeys = new Map<GroupId, CryptoKey>();
  private revision = 0;
  private focusedSecretId: SecretId | null = null;
  private listeners = new Set<(snapshot: VaultSnapshot) => void>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: Plugin,
    private readonly insertReference: (secretId: SecretId) => Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    const loaded = await this.plugin.loadData(STORAGE_FILE).catch(() => null) as VaultData | null;
    if (loaded?.schemaVersion === 1 && Array.isArray(loaded.groups) && Array.isArray(loaded.secrets)) {
      this.data = loaded;
      if (!this.data.groups.some((group) => group.id === DEFAULT_GROUP_ID)) {
        this.data.groups.unshift(makeDefaultGroup());
        await this.persist();
      }
    } else {
      this.data = emptyVault();
      await this.persist();
    }
    this.bump();
  }

  async reloadFromStorage(): Promise<void> {
    this.lockAll();
    const loaded = await this.plugin.loadData(STORAGE_FILE).catch(() => null) as VaultData | null;
    if (loaded?.schemaVersion === 1) this.data = loaded;
    this.bump();
  }

  subscribe(listener: (snapshot: VaultSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): VaultSnapshot {
    return {
      revision: this.revision,
      focusedSecretId: this.focusedSecretId,
      groups: this.data.groups
        .map((group) => ({
          id: group.id,
          name: group.name,
          initialized: Boolean(group.verifier),
          unlocked: this.unlockedKeys.has(group.id),
          secretCount: this.data.secrets.filter((secret) => secret.groupId === group.id).length,
        }))
        .sort((a, b) => a.id === DEFAULT_GROUP_ID ? -1 : b.id === DEFAULT_GROUP_ID ? 1 : a.name.localeCompare(b.name)),
      secrets: this.data.secrets
        .map((secret) => ({
          id: secret.id,
          groupId: secret.groupId,
          label: secret.label,
          createdAt: secret.createdAt,
          updatedAt: secret.updatedAt,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }

  getGroup(groupId: GroupId): SecretGroup | undefined {
    return this.data.groups.find((group) => group.id === groupId);
  }

  getSecret(secretId: SecretId): SecretRecord | undefined {
    return this.data.secrets.find((secret) => secret.id === secretId);
  }

  isGroupUnlocked(groupId: GroupId): boolean {
    return this.unlockedKeys.has(groupId);
  }

  async createGroup(name: string, password: string): Promise<GroupId> {
    name = name.trim();
    if (!name) throw new Error("分组名称不能为空");
    if (!password) throw new Error("口令不能为空");
    if (this.data.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("分组名称已存在");
    }
    const now = Date.now();
    const group: SecretGroup = {
      id: id("grp"),
      name,
      createdAt: now,
      updatedAt: now,
      kdf: createKdf(),
      verifier: null,
    };
    const key = await deriveGroupKey(password, group.kdf);
    group.verifier = await createVerifier(key, group.id);
    this.data.groups.push(group);
    this.unlockedKeys.set(group.id, key);
    await this.persistAndBump();
    return group.id;
  }

  async unlockGroup(groupId: GroupId, password: string): Promise<void> {
    const group = this.requireGroup(groupId);
    const key = await deriveGroupKey(password, group.kdf);
    if (!group.verifier) {
      group.verifier = await createVerifier(key, group.id);
      group.updatedAt = Date.now();
      this.unlockedKeys.set(group.id, key);
      await this.persistAndBump();
      return;
    }
    if (!(await verifyGroupKey(key, group.id, group.verifier))) {
      throw new Error("口令错误");
    }
    this.unlockedKeys.set(group.id, key);
    this.bump();
  }

  lockGroup(groupId: GroupId): void {
    this.unlockedKeys.delete(groupId);
    this.bump();
  }

  lockAll(): void {
    this.unlockedKeys.clear();
    this.bump();
  }

  async changeGroupPassword(groupId: GroupId, newPassword: string): Promise<void> {
    if (!newPassword) throw new Error("新口令不能为空");
    const group = this.requireGroup(groupId);
    const oldKey = this.requireKey(groupId);
    const groupSecrets = this.data.secrets.filter((secret) => secret.groupId === groupId);

    const plaintexts = new Map<SecretId, string>();
    for (const secret of groupSecrets) {
      plaintexts.set(secret.id, await decryptSecretContent(oldKey, groupId, secret.id, secret.encryptedContent));
    }

    const newKdf = createKdf();
    const newKey = await deriveGroupKey(newPassword, newKdf);
    const staged = new Map<SecretId, SecretRecord["encryptedContent"]>();
    for (const secret of groupSecrets) {
      staged.set(secret.id, await encryptSecretContent(newKey, groupId, secret.id, plaintexts.get(secret.id)!));
    }

    group.kdf = newKdf;
    group.verifier = await createVerifier(newKey, groupId);
    group.updatedAt = Date.now();
    for (const secret of groupSecrets) {
      secret.encryptedContent = staged.get(secret.id)!;
      secret.updatedAt = Date.now();
    }
    this.unlockedKeys.set(groupId, newKey);
    await this.persistAndBump();
  }

  async deleteGroup(groupId: GroupId): Promise<void> {
    if (groupId === DEFAULT_GROUP_ID) throw new Error("default 分组不能删除");
    if (this.data.secrets.some((secret) => secret.groupId === groupId)) {
      throw new Error("分组仍包含秘密，请先删除或迁移这些秘密");
    }
    this.data.groups = this.data.groups.filter((group) => group.id !== groupId);
    this.unlockedKeys.delete(groupId);
    await this.persistAndBump();
  }

  async createSecret(groupId: GroupId, label: string, content: string): Promise<SecretId> {
    label = label.trim();
    if (!label) throw new Error("label 不能为空");
    const key = this.requireKey(groupId);
    this.requireGroup(groupId);
    const secretId = id("sec");
    const now = Date.now();
    const record: SecretRecord = {
      id: secretId,
      groupId,
      label,
      encryptedContent: await encryptSecretContent(key, groupId, secretId, content),
      createdAt: now,
      updatedAt: now,
    };
    this.data.secrets.push(record);
    await this.persistAndBump();
    return secretId;
  }

  async readSecret(secretId: SecretId): Promise<string> {
    const secret = this.requireSecret(secretId);
    const key = this.requireKey(secret.groupId);
    return decryptSecretContent(key, secret.groupId, secret.id, secret.encryptedContent);
  }

  async updateSecret(secretId: SecretId, label: string, content: string): Promise<void> {
    label = label.trim();
    if (!label) throw new Error("label 不能为空");
    const secret = this.requireSecret(secretId);
    const key = this.requireKey(secret.groupId);
    secret.label = label;
    secret.encryptedContent = await encryptSecretContent(key, secret.groupId, secret.id, content);
    secret.updatedAt = Date.now();
    await this.persistAndBump();
  }

  async deleteSecret(secretId: SecretId): Promise<void> {
    this.requireSecret(secretId);
    this.data.secrets = this.data.secrets.filter((secret) => secret.id !== secretId);
    if (this.focusedSecretId === secretId) this.focusedSecretId = null;
    await this.persistAndBump();
  }

  async insertSecret(secretId: SecretId): Promise<void> {
    this.requireSecret(secretId);
    await this.insertReference(secretId);
  }

  focusSecret(secretId: SecretId | null): void {
    this.focusedSecretId = secretId;
    this.bump();
  }

  private requireGroup(groupId: GroupId): SecretGroup {
    const group = this.getGroup(groupId);
    if (!group) throw new Error("分组不存在");
    return group;
  }

  private requireSecret(secretId: SecretId): SecretRecord {
    const secret = this.getSecret(secretId);
    if (!secret) throw new Error("秘密不存在");
    return secret;
  }

  private requireKey(groupId: GroupId): CryptoKey {
    const key = this.unlockedKeys.get(groupId);
    if (!key) throw new Error("该分组尚未解锁");
    return key;
  }

  private async persistAndBump(): Promise<void> {
    await this.persist();
    this.bump();
  }

  private async persist(): Promise<void> {
    const snapshot = cloneVault(this.data);
    this.persistChain = this.persistChain.catch(() => undefined).then(() => this.plugin.saveData(STORAGE_FILE, snapshot));
    await this.persistChain;
  }

  private bump(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
