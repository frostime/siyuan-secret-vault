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
  VaultInvalidation,
  VaultSnapshot,
} from "./types";

const STORAGE_FILE = "vault.json";
const DEFAULT_GROUP_ID = "default";
const AUTO_LOCK_IDLE_MS = 15 * 60 * 1000;

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
  private autoLockTimers = new Map<GroupId, ReturnType<typeof setTimeout>>();
  private protyleScopedGroups = new Set<GroupId>();
  private groupLeases = new Map<GroupId, Set<string>>();
  private protyleGroups = new Map<string, Set<GroupId>>();
  private revision = 0;
  private focusedSecretId: SecretId | null = null;
  private listeners = new Set<(snapshot: VaultSnapshot, invalidation: VaultInvalidation) => void>();
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
    this.bump({ scope: "all" });
  }

  async reloadFromStorage(): Promise<void> {
    this.clearAllRuntimeState();
    const loaded = await this.plugin.loadData(STORAGE_FILE).catch(() => null) as VaultData | null;
    if (loaded?.schemaVersion === 1 && Array.isArray(loaded.groups) && Array.isArray(loaded.secrets)) {
      this.data = loaded;
    }
    this.bump({ scope: "all" });
  }

  subscribe(listener: (snapshot: VaultSnapshot, invalidation: VaultInvalidation) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot(), { scope: "none" });
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): VaultSnapshot {
    const counts = new Map<GroupId, number>();
    for (const secret of this.data.secrets) {
      counts.set(secret.groupId, (counts.get(secret.groupId) ?? 0) + 1);
    }

    return {
      revision: this.revision,
      focusedSecretId: this.focusedSecretId,
      groups: this.data.groups
        .map((group) => ({
          id: group.id,
          name: group.name,
          initialized: Boolean(group.verifier),
          unlocked: this.unlockedKeys.has(group.id),
          secretCount: counts.get(group.id) ?? 0,
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
    this.touchGroup(group.id);
    await this.persistAndBump({ scope: "none" });
    return group.id;
  }

  async unlockGroup(groupId: GroupId, password: string, protyleLeaseId?: string): Promise<void> {
    const group = this.requireGroup(groupId);
    const key = await deriveGroupKey(password, group.kdf);
    if (!group.verifier) {
      group.verifier = await createVerifier(key, group.id);
      group.updatedAt = Date.now();
      this.unlockedKeys.set(group.id, key);
      if (protyleLeaseId) {
        this.protyleScopedGroups.add(group.id);
        this.addProtyleLease(group.id, protyleLeaseId);
      }
      this.touchGroup(group.id);
      await this.persistAndBump({ scope: "group", groupId });
      return;
    }
    if (!(await verifyGroupKey(key, group.id, group.verifier))) {
      throw new Error("口令错误");
    }
    this.unlockedKeys.set(group.id, key);
    if (protyleLeaseId) {
      this.protyleScopedGroups.add(group.id);
      this.addProtyleLease(group.id, protyleLeaseId);
    }
    this.touchGroup(group.id);
    this.bump({ scope: "group", groupId });
  }

  lockGroup(groupId: GroupId): void {
    const hadRuntime = this.unlockedKeys.has(groupId)
      || this.protyleScopedGroups.has(groupId)
      || this.groupLeases.has(groupId);
    this.clearGroupRuntimeState(groupId);
    if (hadRuntime) this.bump({ scope: "group", groupId });
  }

  lockAll(): void {
    const hadRuntime = this.unlockedKeys.size > 0 || this.groupLeases.size > 0;
    this.clearAllRuntimeState();
    if (hadRuntime) this.bump({ scope: "all" });
  }

  /**
   * Marks a group as having been unlocked from a document Protyle and gives that
   * Protyle a lease. The last such Protyle closing locks the group immediately.
   */
  markGroupProtyleScoped(groupId: GroupId, protyleId: string): void {
    if (!this.unlockedKeys.has(groupId)) return;
    this.protyleScopedGroups.add(groupId);
    this.addProtyleLease(groupId, protyleId);
    this.touchGroup(groupId);
  }

  /** Adds a lease only when the group was originally unlocked from a Protyle. */
  registerProtyleUse(groupId: GroupId, protyleId: string): void {
    if (!this.unlockedKeys.has(groupId) || !this.protyleScopedGroups.has(groupId)) return;
    this.addProtyleLease(groupId, protyleId);
    this.touchGroup(groupId);
  }

  releaseProtyle(protyleId: string): void {
    const groups = [...(this.protyleGroups.get(protyleId) ?? [])];
    this.protyleGroups.delete(protyleId);

    for (const groupId of groups) {
      const leases = this.groupLeases.get(groupId);
      leases?.delete(protyleId);
      if (leases && leases.size === 0) this.groupLeases.delete(groupId);

      if (this.protyleScopedGroups.has(groupId) && !this.groupLeases.has(groupId)) {
        this.lockGroup(groupId);
      }
    }
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
    this.touchGroup(groupId);
    await this.persistAndBump({ scope: "group", groupId });
  }

  async deleteGroup(groupId: GroupId): Promise<void> {
    if (groupId === DEFAULT_GROUP_ID) throw new Error("default 分组不能删除");
    if (this.data.secrets.some((secret) => secret.groupId === groupId)) {
      throw new Error("分组仍包含秘密，请先删除或迁移这些秘密");
    }
    this.data.groups = this.data.groups.filter((group) => group.id !== groupId);
    this.clearGroupRuntimeState(groupId);
    await this.persistAndBump({ scope: "none" });
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
    this.touchGroup(groupId);
    await this.persistAndBump({ scope: "none" });
    return secretId;
  }

  async readSecret(secretId: SecretId): Promise<string> {
    const secret = this.requireSecret(secretId);
    const key = this.requireKey(secret.groupId);
    const content = await decryptSecretContent(key, secret.groupId, secret.id, secret.encryptedContent);
    this.touchGroup(secret.groupId);
    return content;
  }

  async updateSecret(secretId: SecretId, label: string, content: string): Promise<void> {
    label = label.trim();
    if (!label) throw new Error("label 不能为空");
    const secret = this.requireSecret(secretId);
    const key = this.requireKey(secret.groupId);
    secret.label = label;
    secret.encryptedContent = await encryptSecretContent(key, secret.groupId, secret.id, content);
    secret.updatedAt = Date.now();
    this.touchGroup(secret.groupId);
    await this.persistAndBump({ scope: "secret", secretId });
  }

  async deleteSecret(secretId: SecretId): Promise<void> {
    this.requireSecret(secretId);
    this.data.secrets = this.data.secrets.filter((secret) => secret.id !== secretId);
    if (this.focusedSecretId === secretId) this.focusedSecretId = null;
    await this.persistAndBump({ scope: "secret", secretId });
  }

  async insertSecret(secretId: SecretId): Promise<void> {
    this.requireSecret(secretId);
    await this.insertReference(secretId);
  }

  focusSecret(secretId: SecretId | null): void {
    this.focusedSecretId = secretId;
    this.bump({ scope: "none" });
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

  private touchGroup(groupId: GroupId): void {
    if (!this.unlockedKeys.has(groupId)) return;
    const previous = this.autoLockTimers.get(groupId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.autoLockTimers.delete(groupId);
      if (this.unlockedKeys.has(groupId)) this.lockGroup(groupId);
    }, AUTO_LOCK_IDLE_MS);
    this.autoLockTimers.set(groupId, timer);
  }

  private addProtyleLease(groupId: GroupId, protyleId: string): void {
    let leases = this.groupLeases.get(groupId);
    if (!leases) {
      leases = new Set<string>();
      this.groupLeases.set(groupId, leases);
    }
    leases.add(protyleId);

    let groups = this.protyleGroups.get(protyleId);
    if (!groups) {
      groups = new Set<GroupId>();
      this.protyleGroups.set(protyleId, groups);
    }
    groups.add(groupId);
  }

  private clearGroupRuntimeState(groupId: GroupId): void {
    const timer = this.autoLockTimers.get(groupId);
    if (timer) clearTimeout(timer);
    this.autoLockTimers.delete(groupId);
    this.unlockedKeys.delete(groupId);
    this.protyleScopedGroups.delete(groupId);

    const leases = this.groupLeases.get(groupId);
    if (leases) {
      for (const protyleId of leases) {
        const groups = this.protyleGroups.get(protyleId);
        groups?.delete(groupId);
        if (groups?.size === 0) this.protyleGroups.delete(protyleId);
      }
    }
    this.groupLeases.delete(groupId);
  }

  private clearAllRuntimeState(): void {
    for (const timer of this.autoLockTimers.values()) clearTimeout(timer);
    this.autoLockTimers.clear();
    this.unlockedKeys.clear();
    this.protyleScopedGroups.clear();
    this.groupLeases.clear();
    this.protyleGroups.clear();
  }

  private async persistAndBump(invalidation: VaultInvalidation): Promise<void> {
    await this.persist();
    this.bump(invalidation);
  }

  private async persist(): Promise<void> {
    const snapshot = cloneVault(this.data);
    this.persistChain = this.persistChain.catch(() => undefined).then(() => this.plugin.saveData(STORAGE_FILE, snapshot));
    await this.persistChain;
  }

  private bump(invalidation: VaultInvalidation): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot, invalidation);
  }
}
