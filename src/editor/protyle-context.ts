import { getAllEditor, type Protyle } from "siyuan";
import type { AccessContextId } from "../types";

export interface ResolvedEmbed {
  contextId: AccessContextId;
  frame: HTMLIFrameElement;
  blockId: string;
}

/**
 * Owns identity and DOM lookup for Protyle-scoped Secret access.
 *
 * Context IDs live only for the lifetime of a Protyle instance. Reopening the
 * same document creates a new context and therefore requires authentication
 * again, which is the intended security boundary.
 *
 * SiYuan can keep an opened Protyle mounted while a custom tab is active, and
 * `getAllEditor()` is not a reliable identity source in every tab/layout state.
 * We therefore remember Protyles when lifecycle events expose them and resolve
 * embeds primarily from their actual DOM ancestry. `getAllEditor()` is only a
 * recovery path for Protyles that existed before this registry started.
 */
export class ProtyleContextRegistry {
  private readonly contextByProtyle = new WeakMap<Protyle, AccessContextId>();
  private readonly contextByEditorElement = new WeakMap<HTMLElement, AccessContextId>();
  private readonly protyleByContext = new Map<AccessContextId, Protyle>();
  private readonly contextBySource = new WeakMap<Window, AccessContextId>();
  private readonly frameBySource = new WeakMap<Window, HTMLIFrameElement>();
  private lastActiveProtyle: Protyle | null = null;

  constructor(private readonly pluginName: string) {}

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

    this.rememberProtyle(contextId, protyle);
    return contextId;
  }

  release(protyle: Protyle): AccessContextId | null {
    if (this.lastActiveProtyle === protyle) this.lastActiveProtyle = null;

    const contextId = this.contextByProtyle.get(protyle) ?? null;
    this.contextByProtyle.delete(protyle);

    if (contextId) this.protyleByContext.delete(contextId);
    if (protyle.element) this.contextByEditorElement.delete(protyle.element);
    if (protyle.wysiwyg?.element) this.contextByEditorElement.delete(protyle.wysiwyg.element);

    return contextId;
  }

  getTargetProtyle(): Protyle | null {
    // Keep the last real document target even while the Secret Vault custom tab
    // is active. Requiring it to appear in getAllEditor() made hidden-but-open
    // document tabs look as if no insertion target existed.
    if (this.isUsableProtyle(this.lastActiveProtyle)) {
      return this.lastActiveProtyle;
    }

    // Recovery path for plugin reload/layout restore before lifecycle events
    // have repopulated this registry.
    const editors = getAllEditor();
    for (let index = editors.length - 1; index >= 0; index -= 1) {
      const protyle = editors[index];
      if (!this.isUsableProtyle(protyle)) continue;
      this.capture(protyle);
      return protyle;
    }

    return null;
  }

  resolveEmbed(source: Window): ResolvedEmbed | null {
    const cachedFrame = this.frameBySource.get(source);
    const cachedContext = this.contextBySource.get(source);

    if (
      cachedFrame?.isConnected
      && cachedFrame.contentWindow === source
      && cachedContext
    ) {
      const blockId = this.findEmbedBlockId(cachedFrame);
      if (blockId) return { contextId: cachedContext, frame: cachedFrame, blockId };
    }

    const frame = this.findOwnEmbedFrame(source);
    if (!frame) return null;

    // Fast path: lifecycle capture registered the Protyle/editor DOM already.
    const rememberedContext = this.findContextInAncestors(frame);
    if (rememberedContext) {
      return this.cacheResolvedEmbed(source, frame, rememberedContext);
    }

    // Secondary path: a remembered Protyle may have replaced one of its inner
    // editor elements without emitting a capture event we observed.
    for (const [contextId, protyle] of this.protyleByContext) {
      if (!this.protyleContainsFrame(protyle, frame)) continue;
      this.rememberProtyle(contextId, protyle);
      return this.cacheResolvedEmbed(source, frame, contextId);
    }

    // Last-resort recovery for Protyles restored before this plugin finished
    // loading. Use the broad Protyle root, not only wysiwyg.element.
    for (const protyle of getAllEditor()) {
      if (!this.protyleContainsFrame(protyle, frame)) continue;
      const contextId = this.contextFor(protyle);
      return this.cacheResolvedEmbed(source, frame, contextId);
    }

    return null;
  }

  private rememberProtyle(contextId: AccessContextId, protyle: Protyle): void {
    this.protyleByContext.set(contextId, protyle);

    if (protyle.element) {
      this.contextByEditorElement.set(protyle.element, contextId);
    }
    if (protyle.wysiwyg?.element) {
      this.contextByEditorElement.set(protyle.wysiwyg.element, contextId);
    }
  }

  private findContextInAncestors(frame: HTMLIFrameElement): AccessContextId | null {
    let element: HTMLElement | null = frame;
    while (element) {
      const contextId = this.contextByEditorElement.get(element);
      if (contextId) return contextId;
      element = element.parentElement;
    }
    return null;
  }

  private protyleContainsFrame(protyle: Protyle, frame: HTMLIFrameElement): boolean {
    return Boolean(
      protyle.element?.contains(frame)
      || protyle.wysiwyg?.element?.contains(frame),
    );
  }

  private isUsableProtyle(protyle: Protyle | null): protyle is Protyle {
    if (!protyle?.block?.rootID) return false;
    return Boolean(
      protyle.element?.isConnected
      || protyle.wysiwyg?.element?.isConnected,
    );
  }

  private cacheResolvedEmbed(
    source: Window,
    frame: HTMLIFrameElement,
    contextId: AccessContextId,
  ): ResolvedEmbed | null {
    const blockId = this.findEmbedBlockId(frame);
    if (!blockId) return null;

    this.frameBySource.set(source, frame);
    this.contextBySource.set(source, contextId);
    return { contextId, frame, blockId };
  }

  private findEmbedBlockId(frame: HTMLIFrameElement): string | null {
    const block = frame.closest<HTMLElement>('[data-type="NodeIFrame"][data-node-id]');
    return block?.dataset.nodeId ?? null;
  }

  private findOwnEmbedFrame(source: Window): HTMLIFrameElement | null {
    const cached = this.frameBySource.get(source);
    if (
      cached?.isConnected
      && cached.contentWindow === source
      && this.isOwnEmbedFrame(cached)
    ) {
      return cached;
    }

    try {
      // Avoid instanceof here: Window.frameElement can cross a same-origin
      // realm boundary, where instanceof checks are unnecessarily brittle.
      const frameElement = source.frameElement;
      if (
        frameElement?.tagName === "IFRAME"
        && frameElement.isConnected
      ) {
        const frame = frameElement as HTMLIFrameElement;
        if (frame.contentWindow === source && this.isOwnEmbedFrame(frame)) {
          this.frameBySource.set(source, frame);
          return frame;
        }
      }
    } catch {
      // A cross-origin Window would throw here. Secret Vault embeds are
      // same-origin, so failure simply means this message is not ours.
    }

    // Extremely defensive fallback. This is only used when frameElement cannot
    // be resolved; successful resolution is cached so normal requests stay O(1).
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
      if (frame.contentWindow !== source || !this.isOwnEmbedFrame(frame)) continue;
      this.frameBySource.set(source, frame);
      return frame;
    }

    return null;
  }

  private isOwnEmbedFrame(frame: HTMLIFrameElement): boolean {
    try {
      const url = new URL(frame.src, window.location.href);
      return url.origin === window.location.origin
        && url.pathname === `/plugins/${this.pluginName}/embed/index.html`;
    } catch {
      return false;
    }
  }
}
