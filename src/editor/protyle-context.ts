import { getAllEditor, type Protyle } from "siyuan";
import type { AccessContextId } from "../types";

export interface ResolvedEmbed {
  contextId: AccessContextId;
  frame: HTMLIFrameElement;
  blockId: string;
}

/**
 * Owns Protyle identity and the one-time mapping from a child Window to its
 * document context.
 *
 * The registry deliberately knows nothing about Secret Vault URLs or live
 * session protocol. EmbedSessionBroker validates Secret reference attributes
 * separately. Once a live session is connected, its MessagePort carries the
 * context identity and no further DOM lookup is needed.
 */
export class ProtyleContextRegistry {
  private readonly contextByProtyle = new WeakMap<Protyle, AccessContextId>();
  private readonly contextByEditorElement = new WeakMap<HTMLElement, AccessContextId>();
  private readonly protyleByContext = new Map<AccessContextId, Protyle>();
  private readonly contextBySource = new WeakMap<Window, AccessContextId>();
  private readonly frameBySource = new WeakMap<Window, HTMLIFrameElement>();
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

    const frame = this.findSourceFrame(source);
    if (!frame) return null;

    const rememberedContext = this.findContextInAncestors(frame);
    if (rememberedContext) {
      return this.cacheResolvedEmbed(source, frame, rememberedContext);
    }

    for (const [contextId, protyle] of this.protyleByContext) {
      if (!this.protyleContainsFrame(protyle, frame)) continue;
      this.rememberProtyle(contextId, protyle);
      return this.cacheResolvedEmbed(source, frame, contextId);
    }

    // Last-resort recovery for a Protyle restored before this plugin observed a
    // lifecycle event. This happens only on explicit live-session connection.
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

  private findSourceFrame(source: Window): HTMLIFrameElement | null {
    const cached = this.frameBySource.get(source);
    if (cached?.isConnected && cached.contentWindow === source) {
      return cached;
    }

    try {
      // Window.frameElement is the cheapest and most precise mapping. Avoid an
      // instanceof check because same-origin realm boundaries make it brittle.
      const frameElement = source.frameElement;
      if (frameElement?.tagName === "IFRAME" && frameElement.isConnected) {
        const frame = frameElement as HTMLIFrameElement;
        if (frame.contentWindow === source) {
          this.frameBySource.set(source, frame);
          return frame;
        }
      }
    } catch {
      // Cross-origin windows cannot participate because the broker has already
      // required event.origin === window.location.origin.
    }

    // Defensive recovery only. Normal live sessions hit frameElement once and
    // then remain on their dedicated MessagePort.
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
      if (frame.contentWindow !== source) continue;
      this.frameBySource.set(source, frame);
      return frame;
    }

    return null;
  }
}
