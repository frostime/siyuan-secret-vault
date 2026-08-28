import type { Protyle } from "siyuan";
import type { AccessContextId } from "../types";

/**
 * Owns the identity of live Protyle access contexts.
 *
 * The registry deliberately knows nothing about Secret URLs or document
 * reference formats. A Protyle is the authorization boundary: unlocking one
 * editor must not authorize another editor or the Vault tab.
 */
export class EditorContextRegistry {
  private readonly contextByProtyle = new WeakMap<Protyle, AccessContextId>();

  capture(protyle: Protyle): AccessContextId {
    return this.contextFor(protyle);
  }

  contextFor(protyle: Protyle): AccessContextId {
    let contextId = this.contextByProtyle.get(protyle);
    if (!contextId) {
      contextId = `protyle:${crypto.randomUUID()}`;
      this.contextByProtyle.set(protyle, contextId);
    }
    return contextId;
  }

  release(protyle: Protyle): AccessContextId | null {
    const contextId = this.contextByProtyle.get(protyle) ?? null;
    this.contextByProtyle.delete(protyle);
    return contextId;
  }
}
