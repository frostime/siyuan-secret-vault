import type { AccessContextId, GroupId } from "./types";

interface ContextGrant {
  idleTimer: ReturnType<typeof setTimeout>;
}

interface GroupAccessState {
  key: CryptoKey;
  contexts: Map<AccessContextId, ContextGrant>;
}

/**
 * Owns all runtime-only authorization state.
 *
 * A cached group key is shared internally, but a context may use it only after
 * that context has independently authenticated. Context lifecycle is enforced
 * here as well: once a context is released it cannot be authorized again.
 */
export class GroupAccessManager {
  private readonly groups = new Map<GroupId, GroupAccessState>();
  private readonly activeContexts = new Set<AccessContextId>();
  private readonly releasedContexts = new Set<AccessContextId>();

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly onIdleExpired: (contextId: AccessContextId, groupId: GroupId) => void,
  ) {}

  activateContext(contextId: AccessContextId): void {
    if (this.releasedContexts.has(contextId)) {
      throw new Error("访问上下文已经失效");
    }
    this.activeContexts.add(contextId);
  }

  isContextActive(contextId: AccessContextId): boolean {
    return this.activeContexts.has(contextId);
  }

  assertContextActive(contextId: AccessContextId): void {
    if (!this.isContextActive(contextId)) {
      throw new Error("当前文档已经关闭");
    }
  }

  isAuthorized(contextId: AccessContextId, groupId: GroupId): boolean {
    return this.activeContexts.has(contextId)
      && (this.groups.get(groupId)?.contexts.has(contextId) ?? false);
  }

  /**
   * Grants access only if the context is still alive at the authorization
   * boundary. Returning false prevents an async unlock from resurrecting a
   * Protyle that was destroyed while key derivation was in flight.
   */
  authorize(contextId: AccessContextId, groupId: GroupId, key: CryptoKey): boolean {
    if (!this.activeContexts.has(contextId)) return false;

    let state = this.groups.get(groupId);
    if (!state) {
      state = { key, contexts: new Map() };
      this.groups.set(groupId, state);
    } else {
      // The caller has already verified this key against the committed group
      // verifier. Equivalent derived keys may therefore share one cache slot.
      state.key = key;
    }

    this.scheduleIdleLock(state, contextId, groupId);
    return true;
  }

  getAuthorizedKey(
    contextId: AccessContextId,
    groupId: GroupId,
    options: { touch?: boolean } = {},
  ): CryptoKey {
    const state = this.groups.get(groupId);
    if (!this.activeContexts.has(contextId) || !state?.contexts.has(contextId)) {
      throw new Error("该分组在当前窗口尚未解锁");
    }

    if (options.touch !== false) {
      this.scheduleIdleLock(state, contextId, groupId);
    }
    return state.key;
  }

  peekAuthorizedKey(contextId: AccessContextId, groupId: GroupId): CryptoKey | null {
    if (!this.activeContexts.has(contextId)) return null;
    const state = this.groups.get(groupId);
    return state?.contexts.has(contextId) ? state.key : null;
  }

  touch(contextId: AccessContextId, groupId: GroupId): void {
    if (!this.activeContexts.has(contextId)) return;
    const state = this.groups.get(groupId);
    if (!state?.contexts.has(contextId)) return;
    this.scheduleIdleLock(state, contextId, groupId);
  }

  lock(contextId: AccessContextId, groupId: GroupId): boolean {
    const state = this.groups.get(groupId);
    const grant = state?.contexts.get(contextId);
    if (!state || !grant) return false;

    clearTimeout(grant.idleTimer);
    state.contexts.delete(contextId);

    if (state.contexts.size === 0) {
      this.groups.delete(groupId);
    }
    return true;
  }

  lockGroupEverywhere(groupId: GroupId): boolean {
    const state = this.groups.get(groupId);
    if (!state) return false;

    this.clearGroupState(state);
    this.groups.delete(groupId);
    return true;
  }

  /**
   * Password changes revoke every authorization established against the old
   * password. The initiating context keeps access only if it is still alive
   * when the persisted password change commits.
   */
  replaceKeyKeepingContext(
    groupId: GroupId,
    contextId: AccessContextId,
    key: CryptoKey,
  ): boolean {
    const previous = this.groups.get(groupId);
    const keepContext = this.activeContexts.has(contextId)
      && (previous?.contexts.has(contextId) ?? false);

    if (previous) this.clearGroupState(previous);
    this.groups.delete(groupId);

    // A manual lock or context release that happens while saveData is in
    // flight wins over the earlier password-change request.
    if (!keepContext) return false;

    const next: GroupAccessState = { key, contexts: new Map() };
    this.groups.set(groupId, next);
    this.scheduleIdleLock(next, contextId, groupId);
    return true;
  }

  releaseContext(contextId: AccessContextId): GroupId[] {
    if (!this.activeContexts.delete(contextId)) return [];
    this.releasedContexts.add(contextId);

    const released: GroupId[] = [];
    for (const groupId of [...this.groups.keys()]) {
      if (this.lock(contextId, groupId)) released.push(groupId);
    }
    return released;
  }

  /** Clears grants and key references while keeping live context identities. */
  clearAll(): boolean {
    if (this.groups.size === 0) return false;

    for (const state of this.groups.values()) {
      this.clearGroupState(state);
    }
    this.groups.clear();
    return true;
  }

  dispose(): void {
    this.clearAll();
    this.activeContexts.clear();
    this.releasedContexts.clear();
  }

  private scheduleIdleLock(
    state: GroupAccessState,
    contextId: AccessContextId,
    groupId: GroupId,
  ): void {
    if (!this.activeContexts.has(contextId)) return;

    const previous = state.contexts.get(contextId);
    if (previous) clearTimeout(previous.idleTimer);

    const idleTimer = setTimeout(() => {
      if (!this.lock(contextId, groupId)) return;
      this.onIdleExpired(contextId, groupId);
    }, this.idleTimeoutMs);

    state.contexts.set(contextId, { idleTimer });
  }

  private clearGroupState(state: GroupAccessState): void {
    for (const grant of state.contexts.values()) {
      clearTimeout(grant.idleTimer);
    }
    state.contexts.clear();
  }
}
