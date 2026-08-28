import { getAllEditor, type Protyle } from "siyuan";
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
  private readonly protyleByContext = new Map<AccessContextId, Protyle>();
  private lastActiveProtyle: Protyle | null = null;

  capture(protyle: Protyle): AccessContextId {
    this.lastActiveProtyle = protyle;
    return this.contextFor(protyle);
  }

  contextFor(protyle: Protyle): AccessContextId {
    let contextId = this.contextByProtyle.get(protyle);
    if (!contextId) {
      contextId = `protyle:${crypto.randomUUID()}`;
      this.contextByProtyle.set(protyle, contextId);
    }
    this.protyleByContext.set(contextId, protyle);
    return contextId;
  }

  release(protyle: Protyle): AccessContextId | null {
    if (this.lastActiveProtyle === protyle) this.lastActiveProtyle = null;

    const contextId = this.contextByProtyle.get(protyle) ?? null;
    this.contextByProtyle.delete(protyle);
    if (contextId) this.protyleByContext.delete(contextId);
    return contextId;
  }

  getTargetProtyle(): Protyle | null {
    if (this.isUsableProtyle(this.lastActiveProtyle)) return this.lastActiveProtyle;

    // Plugin reload/layout restore can happen before lifecycle events repopulate
    // the registry. This fallback runs only for an explicit user insertion.
    const editors = getAllEditor();
    for (let index = editors.length - 1; index >= 0; index -= 1) {
      const protyle = editors[index];
      if (!this.isUsableProtyle(protyle)) continue;
      this.capture(protyle);
      return protyle;
    }
    return null;
  }

  private isUsableProtyle(protyle: Protyle | null): protyle is Protyle {
    return Boolean(
      protyle
      && protyle.element?.isConnected
      && protyle.wysiwyg?.element?.isConnected,
    );
  }
}
