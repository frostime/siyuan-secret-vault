import { getAllEditor, type Protyle } from "siyuan";
import type { AccessContextId } from "../types";

export interface ResolvedEmbed {
  contextId: AccessContextId;
  frame: HTMLIFrameElement;
}

/**
 * Owns identity and DOM lookup for Protyle-scoped Secret access.
 *
 * Context IDs live only for the lifetime of a Protyle instance. Reopening the
 * same document creates a new context and therefore requires authentication
 * again, which is the intended security boundary.
 */
export class ProtyleContextRegistry {
  private readonly contextByProtyle = new WeakMap<Protyle, AccessContextId>();
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
    return contextId;
  }

  release(protyle: Protyle): AccessContextId | null {
    if (this.lastActiveProtyle === protyle) this.lastActiveProtyle = null;

    const contextId = this.contextByProtyle.get(protyle) ?? null;
    this.contextByProtyle.delete(protyle);
    return contextId;
  }

  getTargetProtyle(): Protyle | null {
    const editors = getAllEditor();

    if (
      this.lastActiveProtyle?.block?.rootID
      && editors.includes(this.lastActiveProtyle)
    ) {
      return this.lastActiveProtyle;
    }

    for (let index = editors.length - 1; index >= 0; index -= 1) {
      const protyle = editors[index];
      if (!protyle?.block?.rootID) continue;
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
      return { contextId: cachedContext, frame: cachedFrame };
    }

    const frame = this.findOwnEmbedFrame(source);
    if (!frame) return null;

    for (const protyle of getAllEditor()) {
      if (!protyle.wysiwyg?.element?.contains(frame)) continue;

      const contextId = this.contextFor(protyle);
      this.frameBySource.set(source, frame);
      this.contextBySource.set(source, contextId);
      return { contextId, frame };
    }

    return null;
  }

  resizeEmbed(source: Window, requestedHeight: number): void {
    const resolved = this.resolveEmbed(source);
    if (!resolved) return;

    const block = resolved.frame.closest<HTMLElement>('[data-type="NodeIFrame"]');
    if (!block) return;

    const height = Math.round(Math.max(42, Math.min(420, requestedHeight)));
    const cssHeight = `${height}px`;

    // NodeIFrame's inline height controls the space occupied in Protyle. The
    // inner iframe must match it, but we intentionally do not persist this UI
    // state through the kernel: resize remains a lazy, session-local operation.
    if (block.style.height === cssHeight && resolved.frame.style.height === cssHeight) {
      return;
    }

    block.style.height = cssHeight;
    resolved.frame.style.height = cssHeight;
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
      const frame = source.frameElement;
      if (
        frame instanceof HTMLIFrameElement
        && frame.isConnected
        && frame.contentWindow === source
        && this.isOwnEmbedFrame(frame)
      ) {
        this.frameBySource.set(source, frame);
        return frame;
      }
    } catch {
      // A cross-origin Window would throw here. Secret Vault embeds are
      // same-origin, so failure simply means this message is not ours.
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
