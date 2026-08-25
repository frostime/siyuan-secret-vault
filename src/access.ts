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
 * that context has independently authenticated. When the last authorized
 * context disappears, the CryptoKey reference is released as well.
 */
export class GroupAccessManager {
  private readonly groups = new Map<GroupId, GroupAccessState>();

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly onIdleExpired: (contextId: AccessContextId, groupId: GroupId) => void,
  ) {}

  isAuthorized(contextId: AccessContextId, groupId: GroupId): boolean {
    return this.groups.get(groupId)?.contexts.has(contextId) ?? false;
  }

  authorize(contextId: AccessContextId, groupId: GroupId, key: CryptoKey): void {
    let state = this.groups.get(groupId);
    if (!state) {
      state = { key, contexts: new Map() };
      this.groups.set(groupId, state);
    } else {
      // The caller has already verified this newly derived key against the
      // persisted verifier, so replacing the equivalent in-memory key is safe.
      state.key = key;
    }

    this.scheduleIdleLock(state, contextId, groupId);
  }

  getAuthorizedKey(
    contextId: AccessContextId,
    groupId: GroupId,
    options: { touch?: boolean } = {},
  ): CryptoKey {
    const state = this.groups.get(groupId);
    if (!state?.contexts.has(contextId)) {
      throw new Error("该分组在当前窗口尚未解锁");
    }

    if (options.touch !== false) {
      this.scheduleIdleLock(state, contextId, groupId);
    }
    return state.key;
  }

  peekAuthorizedKey(contextId: AccessContextId, groupId: GroupId): CryptoKey | null {
    const state = this.groups.get(groupId);
    return state?.contexts.has(contextId) ? state.key : null;
  }

  touch(contextId: AccessContextId, groupId: GroupId): void {
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
   * Password changes invalidate every other context because their prior
   * authorization was established against the old password-derived key.
   */
  replaceKeyKeepingContext(
    groupId: GroupId,
    contextId: AccessContextId,
    key: CryptoKey,
  ): void {
    const previous = this.groups.get(groupId);
    if (previous) this.clearGroupState(previous);

    const next: GroupAccessState = { key, contexts: new Map() };
    this.groups.set(groupId, next);
    this.scheduleIdleLock(next, contextId, groupId);
  }

  releaseContext(contextId: AccessContextId): GroupId[] {
    const released: GroupId[] = [];

    for (const groupId of [...this.groups.keys()]) {
      if (this.lock(contextId, groupId)) released.push(groupId);
    }
    return released;
  }

  clearAll(): boolean {
    if (this.groups.size === 0) return false;

    for (const state of this.groups.values()) {
      this.clearGroupState(state);
    }
    this.groups.clear();
    return true;
  }

  private scheduleIdleLock(
    state: GroupAccessState,
    contextId: AccessContextId,
    groupId: GroupId,
  ): void {
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
