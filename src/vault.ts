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
import { VaultMutationCoordinator } from "./mutation-coordinator";
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
import { VAULT_CONTEXT_ID } from "./types";

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
 * Owns committed vault data and the crypto operations that interpret it.
 *
 * Persistent mutations are staged on a detached VaultData copy and serialized
 * by VaultMutationCoordinator. `this.data` therefore always represents the
 * last successfully persisted state; readers never observe half-committed KDF
 * or ciphertext changes.
 *
 * Runtime authorization is delegated to GroupAccessManager. Public operations
 * receive an AccessContextId so "a key exists" never implies "this window is
 * authorized".
 */
export class VaultController {
  private data: VaultData = emptyVault();
  private readonly access: GroupAccessManager;
  private readonly mutations = new VaultMutationCoordinator();
  private revision = 0;
  private readonly snapshotSubscriptions = new Set<SnapshotSubscription>();
  private readonly invalidationListeners = new Set<InvalidationListener>();

  constructor(private readonly plugin: Plugin) {
    this.access = new GroupAccessManager(
      AUTO_LOCK_IDLE_MS,
      (contextId, groupId) => this.publish({ scope: "context-group", contextId, groupId }),
    );
    this.access.activateContext(VAULT_CONTEXT_ID);
  }

  async initialize(): Promise<void> {
    await this.mutations.runExclusive(async () => {
      const loaded = await this.readStoredVault();

      // Missing storage is a valid first-run state. Keep the default vault only
      // in memory until the first real user mutation. Eagerly writing an empty
      // vault here can turn a new device that has not finished official sync
      // into a competing local writer.
      if (!loaded) {
        this.data = emptyVault();
        this.publish({ scope: "all" });
        return;
      }

      if (this.ensureDefaultGroup(loaded)) {
        await this.persist(loaded);
      }

      this.data = loaded;
      this.publish({ scope: "all" });
    });
  }

  async reloadFromStorage(): Promise<void> {
    await this.mutations.runExclusive(async () => {
      const loaded = await this.readStoredVault();
      const next = loaded ?? cloneVault(this.data);

      if (this.ensureDefaultGroup(next)) {
        await this.persist(next);
      }

      this.data = next;
      this.access.clearAll();
      this.publish({ scope: "all" });
    });
  }

  dispose(): void {
    this.mutations.close();
    this.access.dispose();
    this.snapshotSubscriptions.clear();
    this.invalidationListeners.clear();
  }

  activateContext(contextId: AccessContextId): void {
    this.access.activateContext(contextId);
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
    return this.mutations.runExclusive(async () => {
      this.access.assertContextActive(contextId);

      const normalizedName = name.trim();
      if (!normalizedName) throw new Error("分组名称不能为空");
      if (!password) throw new Error("口令不能为空");

      const next = cloneVault(this.data);
      if (next.groups.some((group) => group.name.toLowerCase() === normalizedName.toLowerCase())) {
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

      // Do not begin a persistent write for a Protyle that disappeared while
      // PBKDF2/verifier work was in flight.
      this.access.assertContextActive(contextId);
      next.groups.push(group);
      await this.persistAndCommit(next);

      this.access.authorize(contextId, group.id, key);
      this.publish();
      return group.id;
    });
  }

  async unlockGroup(
    contextId: AccessContextId,
    groupId: GroupId,
    password: string,
  ): Promise<void> {
    await this.mutations.runExclusive(async () => {
      this.access.assertContextActive(contextId);

      const group = this.requireGroup(groupId);
      const key = await deriveGroupKey(password, group.kdf);
      let initializedNow = false;

      if (group.verifier) {
        if (!(await verifyGroupKey(key, group.id, group.verifier))) {
          throw new Error("口令错误");
        }
      } else {
        const verifier = await createVerifier(key, group.id);

        // A second unlock or any other persistent mutation cannot interleave
        // here because the complete unlock lifecycle owns the mutation queue.
        this.access.assertContextActive(contextId);
        const next = cloneVault(this.data);
        const nextGroup = this.requireGroup(groupId, next);
        nextGroup.verifier = verifier;
        nextGroup.updatedAt = Date.now();
        await this.persistAndCommit(next);
        initializedNow = true;
      }

      if (!this.access.authorize(contextId, groupId, key)) {
        if (initializedNow) this.publish();
        throw new Error(
          initializedNow
            ? "当前文档已经关闭；分组口令已初始化，但未保留解锁状态"
            : "当前文档已经关闭",
        );
      }

      this.publish({ scope: "context-group", contextId, groupId });
    });
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
    await this.mutations.runExclusive(async () => {
      if (!newPassword) throw new Error("新口令不能为空");

      const next = cloneVault(this.data);
      const group = this.requireGroup(groupId, next);
      const oldKey = this.access.getAuthorizedKey(contextId, groupId);
      const groupSecrets = next.secrets.filter((secret) => secret.groupId === groupId);

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

      for (const secret of groupSecrets) {
        secret.encryptedContent = await encryptSecretContent(
          newKey,
          groupId,
          secret.id,
          plaintexts.get(secret.id)!,
        );
        secret.updatedAt = Date.now();
      }

      group.kdf = newKdf;
      group.verifier = newVerifier;
      group.updatedAt = Date.now();

      // Lock/context destruction is runtime-only and may occur while crypto is
      // running, so re-check authorization immediately before persistence.
      this.access.getAuthorizedKey(contextId, groupId, { touch: false });
      await this.persistAndCommit(next);

      // Always revoke old-password grants. If the initiating context vanished
      // while saveData was in flight, the new key is simply not cached.
      this.access.replaceKeyKeepingContext(groupId, contextId, newKey);
      this.publish({ scope: "group", groupId });
    });
  }

  async deleteGroup(groupId: GroupId): Promise<void> {
    await this.mutations.runExclusive(async () => {
      if (groupId === DEFAULT_GROUP_ID) throw new Error("default 分组不能删除");

      const next = cloneVault(this.data);
      if (next.secrets.some((secret) => secret.groupId === groupId)) {
        throw new Error("分组仍包含秘密，请先删除或迁移这些秘密");
      }

      const index = next.groups.findIndex((group) => group.id === groupId);
      if (index < 0) throw new Error("分组不存在");

      next.groups.splice(index, 1);
      await this.persistAndCommit(next);

      this.access.lockGroupEverywhere(groupId);
      this.publish();
    });
  }

  async createSecret(
    contextId: AccessContextId,
    groupId: GroupId,
    label: string,
    content: string,
  ): Promise<SecretId> {
    return this.mutations.runExclusive(async () => {
      const normalizedLabel = label.trim();
      if (!normalizedLabel) throw new Error("label 不能为空");

      const next = cloneVault(this.data);
      this.requireGroup(groupId, next);
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

      // Manual lock or Protyle destruction may happen during encryption.
      this.access.getAuthorizedKey(contextId, groupId, { touch: false });
      next.secrets.push(record);
      await this.persistAndCommit(next);

      this.publish();
      return secretId;
    });
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
    await this.mutations.runExclusive(async () => {
      const normalizedLabel = label.trim();
      if (!normalizedLabel) throw new Error("label 不能为空");

      const next = cloneVault(this.data);
      const secret = this.requireSecret(secretId, next);
      const key = this.access.getAuthorizedKey(contextId, secret.groupId);

      secret.label = normalizedLabel;
      secret.encryptedContent = await encryptSecretContent(
        key,
        secret.groupId,
        secret.id,
        content,
      );
      secret.updatedAt = Date.now();

      this.access.getAuthorizedKey(contextId, secret.groupId, { touch: false });
      await this.persistAndCommit(next);
      this.publish({ scope: "secret", secretId });
    });
  }

  async deleteSecret(contextId: AccessContextId, secretId: SecretId): Promise<void> {
    await this.mutations.runExclusive(async () => {
      const next = cloneVault(this.data);
      const secret = this.requireSecret(secretId, next);
      this.access.getAuthorizedKey(contextId, secret.groupId);

      const index = next.secrets.findIndex((item) => item.id === secretId);
      next.secrets.splice(index, 1);
      await this.persistAndCommit(next);

      this.publish({ scope: "secret", secretId });
    });
  }

  private requireGroup(groupId: GroupId, data: VaultData = this.data): SecretGroup {
    const group = data.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("分组不存在");
    return group;
  }

  private requireSecret(secretId: SecretId, data: VaultData = this.data): SecretRecord {
    const secret = data.secrets.find((item) => item.id === secretId);
    if (!secret) throw new Error("秘密不存在");
    return secret;
  }

  private async readStoredVault(): Promise<VaultData | null> {
    const loaded = await this.plugin.loadData(STORAGE_FILE);
    if (loaded == null) return null;

    // A read failure must propagate, and an existing but malformed vault must
    // never be silently treated as "no data". Otherwise a later mutation could
    // overwrite recoverable/syncing data with a freshly created empty vault.
    if (!isVaultData(loaded)) {
      throw new Error("秘密库数据格式无效；已拒绝覆盖现有 vault.json");
    }

    return loaded;
  }

  private ensureDefaultGroup(data: VaultData): boolean {
    if (data.groups.some((group) => group.id === DEFAULT_GROUP_ID)) return false;
    data.groups.unshift(makeDefaultGroup());
    return true;
  }

  /** Persists a detached staged state, then atomically publishes it in memory. */
  private async persistAndCommit(next: VaultData): Promise<void> {
    await this.persist(next);
    this.data = next;
  }

  private async persist(data: VaultData): Promise<void> {
    await this.plugin.saveData(STORAGE_FILE, cloneVault(data));
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
