import type { Plugin } from "siyuan";
import { GroupAccessManager } from "./access";
import {
  createKdf,
  createVerifier,
  decryptSecretContent,
  deriveGroupKey,
  encryptSecretContent,
  verifyGroupKey,
} from "./crypto";
import type {
  AccessContextId,
  GroupId,
  SecretGroup,
  SecretId,
  SecretRecord,
  SecretViewState,
  VaultData,
  VaultInvalidation,
  VaultSnapshot,
} from "./types";

const STORAGE_FILE = "vault.json";
const DEFAULT_GROUP_ID = "default";
const AUTO_LOCK_IDLE_MS = 15 * 60 * 1000;

type SnapshotListener = (snapshot: VaultSnapshot) => void;
type InvalidationListener = (invalidation: VaultInvalidation) => void;

interface SnapshotSubscription {
  contextId: AccessContextId;
  listener: SnapshotListener;
}

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

function isVaultData(value: unknown): value is VaultData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VaultData>;
  return candidate.schemaVersion === 1
    && Array.isArray(candidate.groups)
    && Array.isArray(candidate.secrets);
}

function cloneVault(data: VaultData): VaultData {
  return structuredClone(data);
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Owns persisted vault data and the crypto operations that interpret it.
 *
 * Runtime authorization is delegated to GroupAccessManager. Public operations
 * always receive an AccessContextId, making it impossible for a caller to
 * accidentally treat "a key exists in memory" as "this window is unlocked".
 */
export class VaultController {
  private data: VaultData = emptyVault();
  private readonly access: GroupAccessManager;
  private revision = 0;
  private readonly snapshotSubscriptions = new Set<SnapshotSubscription>();
  private readonly invalidationListeners = new Set<InvalidationListener>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {
    this.access = new GroupAccessManager(
      AUTO_LOCK_IDLE_MS,
      (contextId, groupId) => this.publish({ scope: "context-group", contextId, groupId }),
    );
  }

  async initialize(): Promise<void> {
    const loaded = await this.readStoredVault();
    this.data = loaded ?? emptyVault();

    if (this.ensureDefaultGroup()) {
      await this.persist();
    } else if (!loaded) {
      await this.persist();
    }

    this.publish({ scope: "all" });
  }

  async reloadFromStorage(): Promise<void> {
    this.access.clearAll();
    const loaded = await this.readStoredVault();
    if (loaded) this.data = loaded;

    if (this.ensureDefaultGroup()) {
      await this.persist();
    }

    this.publish({ scope: "all" });
  }

  dispose(): void {
    this.access.clearAll();
    this.snapshotSubscriptions.clear();
    this.invalidationListeners.clear();
  }

  subscribe(contextId: AccessContextId, listener: SnapshotListener): () => void {
    const subscription = { contextId, listener };
    this.snapshotSubscriptions.add(subscription);
    listener(this.getSnapshot(contextId));
    return () => this.snapshotSubscriptions.delete(subscription);
  }

  subscribeInvalidations(listener: InvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  getSnapshot(contextId: AccessContextId): VaultSnapshot {
    const secretCounts = new Map<GroupId, number>();
    for (const secret of this.data.secrets) {
      secretCounts.set(secret.groupId, (secretCounts.get(secret.groupId) ?? 0) + 1);
    }

    return {
      revision: this.revision,
      groups: this.data.groups
        .map((group) => ({
          id: group.id,
          name: group.name,
          initialized: Boolean(group.verifier),
          unlocked: this.access.isAuthorized(contextId, group.id),
          secretCount: secretCounts.get(group.id) ?? 0,
        }))
        .sort((a, b) => (
          a.id === DEFAULT_GROUP_ID
            ? -1
            : b.id === DEFAULT_GROUP_ID
              ? 1
              : a.name.localeCompare(b.name)
        )),
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

  getGroup(groupId: GroupId): Readonly<SecretGroup> | undefined {
    return this.data.groups.find((group) => group.id === groupId);
  }

  getSecret(secretId: SecretId): Readonly<SecretRecord> | undefined {
    return this.data.secrets.find((secret) => secret.id === secretId);
  }

  isGroupUnlocked(contextId: AccessContextId, groupId: GroupId): boolean {
    return this.access.isAuthorized(contextId, groupId);
  }

  async createGroup(
    contextId: AccessContextId,
    name: string,
    password: string,
  ): Promise<GroupId> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("分组名称不能为空");
    if (!password) throw new Error("口令不能为空");
    if (this.data.groups.some((group) => group.name.toLowerCase() === normalizedName.toLowerCase())) {
      throw new Error("分组名称已存在");
    }

    const now = Date.now();
    const group: SecretGroup = {
      id: makeId("grp"),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      kdf: createKdf(),
      verifier: null,
    };
    const key = await deriveGroupKey(password, group.kdf);
    group.verifier = await createVerifier(key, group.id);

    this.data.groups.push(group);
    try {
      await this.persist();
    } catch (error) {
      this.data.groups = this.data.groups.filter((item) => item.id !== group.id);
      throw error;
    }

    this.access.authorize(contextId, group.id, key);
    this.publish();
    return group.id;
  }

  async unlockGroup(
    contextId: AccessContextId,
    groupId: GroupId,
    password: string,
  ): Promise<void> {
    const group = this.requireGroup(groupId);
    const key = await deriveGroupKey(password, group.kdf);

    if (group.verifier) {
      if (!(await verifyGroupKey(key, group.id, group.verifier))) {
        throw new Error("口令错误");
      }
    } else {
      const previousUpdatedAt = group.updatedAt;
      const verifier = await createVerifier(key, group.id);
      group.verifier = verifier;
      group.updatedAt = Date.now();

      try {
        await this.persist();
      } catch (error) {
        group.verifier = null;
        group.updatedAt = previousUpdatedAt;
        throw error;
      }
    }

    this.access.authorize(contextId, groupId, key);
    this.publish({ scope: "context-group", contextId, groupId });
  }

  lockGroup(contextId: AccessContextId, groupId: GroupId): void {
    if (!this.access.lock(contextId, groupId)) return;
    this.publish({ scope: "context-group", contextId, groupId });
  }

  releaseContext(contextId: AccessContextId): void {
    this.access.releaseContext(contextId);
  }

  lockAll(): void {
    if (!this.access.clearAll()) return;
    this.publish({ scope: "all" });
  }

  async changeGroupPassword(
    contextId: AccessContextId,
    groupId: GroupId,
    newPassword: string,
  ): Promise<void> {
    if (!newPassword) throw new Error("新口令不能为空");

    const group = this.requireGroup(groupId);
    const oldKey = this.access.getAuthorizedKey(contextId, groupId);
    const groupSecrets = this.data.secrets.filter((secret) => secret.groupId === groupId);

    const plaintexts = new Map<SecretId, string>();
    for (const secret of groupSecrets) {
      plaintexts.set(
        secret.id,
        await decryptSecretContent(oldKey, groupId, secret.id, secret.encryptedContent),
      );
    }

    const newKdf = createKdf();
    const newKey = await deriveGroupKey(newPassword, newKdf);
    const newVerifier = await createVerifier(newKey, groupId);
    const stagedPayloads = new Map<SecretId, SecretRecord["encryptedContent"]>();

    for (const secret of groupSecrets) {
      stagedPayloads.set(
        secret.id,
        await encryptSecretContent(newKey, groupId, secret.id, plaintexts.get(secret.id)!),
      );
    }

    const oldGroupState = {
      kdf: group.kdf,
      verifier: group.verifier,
      updatedAt: group.updatedAt,
    };
    const oldSecretState = groupSecrets.map((secret) => ({
      secret,
      encryptedContent: secret.encryptedContent,
      updatedAt: secret.updatedAt,
    }));

    group.kdf = newKdf;
    group.verifier = newVerifier;
    group.updatedAt = Date.now();
    for (const secret of groupSecrets) {
      secret.encryptedContent = stagedPayloads.get(secret.id)!;
      secret.updatedAt = Date.now();
    }

    try {
      await this.persist();
    } catch (error) {
      group.kdf = oldGroupState.kdf;
      group.verifier = oldGroupState.verifier;
      group.updatedAt = oldGroupState.updatedAt;
      for (const previous of oldSecretState) {
        previous.secret.encryptedContent = previous.encryptedContent;
        previous.secret.updatedAt = previous.updatedAt;
      }
      throw error;
    }

    // Other contexts authenticated using the old password, so changing the
    // password deliberately revokes them. The initiating context stays open.
    this.access.replaceKeyKeepingContext(groupId, contextId, newKey);
    this.publish({ scope: "group", groupId });
  }

  async deleteGroup(groupId: GroupId): Promise<void> {
    if (groupId === DEFAULT_GROUP_ID) throw new Error("default 分组不能删除");
    if (this.data.secrets.some((secret) => secret.groupId === groupId)) {
      throw new Error("分组仍包含秘密，请先删除或迁移这些秘密");
    }

    const index = this.data.groups.findIndex((group) => group.id === groupId);
    if (index < 0) throw new Error("分组不存在");

    const [removed] = this.data.groups.splice(index, 1);
    try {
      await this.persist();
    } catch (error) {
      this.data.groups.splice(index, 0, removed);
      throw error;
    }

    this.access.lockGroupEverywhere(groupId);
    this.publish();
  }

  async createSecret(
    contextId: AccessContextId,
    groupId: GroupId,
    label: string,
    content: string,
  ): Promise<SecretId> {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) throw new Error("label 不能为空");

    this.requireGroup(groupId);
    const key = this.access.getAuthorizedKey(contextId, groupId);
    const secretId = makeId("sec");
    const now = Date.now();
    const record: SecretRecord = {
      id: secretId,
      groupId,
      label: normalizedLabel,
      encryptedContent: await encryptSecretContent(key, groupId, secretId, content),
      createdAt: now,
      updatedAt: now,
    };

    this.data.secrets.push(record);
    try {
      await this.persist();
    } catch (error) {
      this.data.secrets = this.data.secrets.filter((secret) => secret.id !== secretId);
      throw error;
    }

    this.publish();
    return secretId;
  }

  async getSecretView(
    contextId: AccessContextId,
    secretId: SecretId,
  ): Promise<SecretViewState> {
    const secret = this.requireSecret(secretId);
    const group = this.requireGroup(secret.groupId);
    const key = this.access.peekAuthorizedKey(contextId, group.id);

    return {
      contextId,
      secretId: secret.id,
      label: secret.label,
      groupId: group.id,
      groupName: group.name,
      locked: !key,
      content: key
        ? await decryptSecretContent(key, group.id, secret.id, secret.encryptedContent)
        : undefined,
    };
  }

  async readSecret(contextId: AccessContextId, secretId: SecretId): Promise<string> {
    const secret = this.requireSecret(secretId);
    const key = this.access.getAuthorizedKey(contextId, secret.groupId);
    return decryptSecretContent(key, secret.groupId, secret.id, secret.encryptedContent);
  }

  async updateSecret(
    contextId: AccessContextId,
    secretId: SecretId,
    label: string,
    content: string,
  ): Promise<void> {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) throw new Error("label 不能为空");

    const secret = this.requireSecret(secretId);
    const key = this.access.getAuthorizedKey(contextId, secret.groupId);
    const previous = {
      label: secret.label,
      encryptedContent: secret.encryptedContent,
      updatedAt: secret.updatedAt,
    };

    secret.label = normalizedLabel;
    secret.encryptedContent = await encryptSecretContent(
      key,
      secret.groupId,
      secret.id,
      content,
    );
    secret.updatedAt = Date.now();

    try {
      await this.persist();
    } catch (error) {
      secret.label = previous.label;
      secret.encryptedContent = previous.encryptedContent;
      secret.updatedAt = previous.updatedAt;
      throw error;
    }

    this.publish({ scope: "secret", secretId });
  }

  async deleteSecret(contextId: AccessContextId, secretId: SecretId): Promise<void> {
    const secret = this.requireSecret(secretId);
    this.access.getAuthorizedKey(contextId, secret.groupId);

    const index = this.data.secrets.findIndex((item) => item.id === secretId);
    const [removed] = this.data.secrets.splice(index, 1);

    try {
      await this.persist();
    } catch (error) {
      this.data.secrets.splice(index, 0, removed);
      throw error;
    }

    this.publish({ scope: "secret", secretId });
  }

  private requireGroup(groupId: GroupId): SecretGroup {
    const group = this.data.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("分组不存在");
    return group;
  }

  private requireSecret(secretId: SecretId): SecretRecord {
    const secret = this.data.secrets.find((item) => item.id === secretId);
    if (!secret) throw new Error("秘密不存在");
    return secret;
  }

  private async readStoredVault(): Promise<VaultData | null> {
    const loaded = await this.plugin.loadData(STORAGE_FILE).catch(() => null);
    return isVaultData(loaded) ? loaded : null;
  }

  private ensureDefaultGroup(): boolean {
    if (this.data.groups.some((group) => group.id === DEFAULT_GROUP_ID)) return false;
    this.data.groups.unshift(makeDefaultGroup());
    return true;
  }

  private async persist(): Promise<void> {
    const snapshot = cloneVault(this.data);
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.plugin.saveData(STORAGE_FILE, snapshot));
    await this.persistChain;
  }

  private publish(invalidation?: VaultInvalidation): void {
    this.revision += 1;

    for (const subscription of this.snapshotSubscriptions) {
      subscription.listener(this.getSnapshot(subscription.contextId));
    }

    if (!invalidation) return;
    for (const listener of this.invalidationListeners) {
      listener(invalidation);
    }
  }
}
