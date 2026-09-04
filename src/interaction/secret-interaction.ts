import { mount, unmount } from "svelte";
import { showMessage, type Plugin, type Protyle } from "siyuan";
import type { AuthorizationRevocation, AccessContextId, SecretViewState } from "../types";
import type { VaultController } from "../vault";
import { SecretReferenceService, type SecretReferenceSource } from "../reference/secret-reference";
import type { EditorContextRegistry } from "./editor-context";
import SecretPopover from "./SecretPopover.svelte";

const ANCHOR_TTL_MS = 1_500;
const POPOVER_MARGIN = 10;
const POPOVER_WIDTH = 420;
const POPOVER_HEIGHT_ESTIMATE = 360;

type SvelteApp = ReturnType<typeof mount>;

interface PendingAnchor {
  href: string;
  secretId: string;
  blockId: string;
  contextId: AccessContextId;
  rect: DOMRect;
  capturedAt: number;
}

interface ActivePopover {
  host: HTMLElement;
  app: SvelteApp;
  secretId: string;
  groupId: string;
  contextId: AccessContextId;
  blockId: string;
}

/**
 * Owns the complete transient document interaction path for v4 references.
 *
 * `click-editorcontent` captures editor/context/geometry. The immediately
 * following `open-siyuan-url-plugin` event is the authoritative user intent.
 * Nothing is installed per reference block; at most one plugin-owned popover
 * exists in document.body after an explicit click.
 */
export class SecretInteractionController {
  private pendingAnchor: PendingAnchor | null = null;
  private active: ActivePopover | null = null;
  private unsubscribeRevocations: (() => void) | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly vault: VaultController,
    private readonly references: SecretReferenceService,
    private readonly contexts: EditorContextRegistry,
  ) {}

  start(): void {
    this.plugin.eventBus.on("click-editorcontent", this.handleEditorClick);
    this.plugin.eventBus.on("open-siyuan-url-plugin", this.handlePluginUrl);
    this.unsubscribeRevocations = this.vault.subscribeRevocations(this.handleRevocation);
  }

  dispose(): void {
    this.plugin.eventBus.off("click-editorcontent", this.handleEditorClick);
    this.plugin.eventBus.off("open-siyuan-url-plugin", this.handlePluginUrl);
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = null;
    this.pendingAnchor = null;
    this.close("dispose");
  }

  close(_reason = "close"): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown, true);
    unmount(active.app);
    active.host.remove();
  }

  private readonly handleEditorClick = (
    event: CustomEvent<{ protyle?: Protyle; event?: MouseEvent }>,
  ): void => {
    const protyle = event.detail?.protyle;
    const mouseEvent = event.detail?.event;
    if (!protyle || !mouseEvent) return;

    const link = findPluginLink(mouseEvent.target);
    const href = link?.dataset.href ?? "";
    const parsed = this.references.parseSecretUrl(href);
    if (!link || !parsed) return;

    const block = link.closest<HTMLElement>("[data-node-id]");
    const blockId = block?.dataset.nodeId;
    if (!blockId || !protyle.wysiwyg?.element?.contains(block)) return;

    const contextId = this.contexts.capture(protyle);
    this.vault.activateContext(contextId);
    this.pendingAnchor = {
      href,
      secretId: parsed.secretId,
      blockId,
      contextId,
      rect: link.getBoundingClientRect(),
      capturedAt: performance.now(),
    };
  };

  private readonly handlePluginUrl = (
    event: CustomEvent<{ url?: string }>,
  ): void => {
    const url = event.detail?.url ?? "";
    const parsed = this.references.parseSecretUrl(url);
    if (!parsed) return;

    const pending = this.takeMatchingAnchor(url, parsed.secretId);
    if (!pending) {
      showMessage("请从文档中的 Secret 引用打开该秘密", 4000, "error");
      return;
    }

    void this.openFromAnchor(parsed.secretId, pending).catch((error) => {
      showMessage(errorMessage(error), 5000, "error");
    });
  };

  private takeMatchingAnchor(url: string, secretId: string): PendingAnchor | null {
    const pending = this.pendingAnchor;
    this.pendingAnchor = null;
    if (!pending) return null;
    if (performance.now() - pending.capturedAt > ANCHOR_TTL_MS) return null;
    if (pending.href !== url || pending.secretId !== secretId) return null;
    return pending;
  }

  private async openFromAnchor(secretId: string, anchor: PendingAnchor): Promise<void> {
    const attrs = await this.references.loadReference(anchor.blockId, secretId);
    if (!attrs) {
      throw new Error("Secret 链接与当前块属性不一致，已拒绝打开");
    }

    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("秘密不存在");
    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("秘密所属分组不存在");

    this.vault.activateContext(anchor.contextId);
    const initialState = await this.vault.getSecretView(anchor.contextId, secretId);
    this.openPopover(anchor, initialState, Boolean(group.verifier));

    // The popover renders live Vault data, so a stale reference snapshot never
    // blocks opening. Refresh it in the background; failure is non-blocking.
    if (this.references.snapshotNeedsRefresh(attrs, secret, group.name)) {
      void this.refreshReferenceSnapshot(anchor.blockId, secret, group.name);
    }
  }

  private async refreshReferenceSnapshot(
    blockId: string,
    secret: SecretReferenceSource,
    groupName: string,
  ): Promise<void> {
    try {
      await this.references.refreshSnapshot(blockId, secret, groupName);
      showMessage(`已刷新引用快照：${secret.label}`);
    } catch (error) {
      // The reference may have been edited or deleted while the popover was
      // opening; refreshSnapshot re-validates before writing, so this only
      // means the block was not refreshed. Never fail the interaction.
      console.warn("引用快照刷新失败", errorMessage(error));
    }
  }

  private openPopover(
    anchor: PendingAnchor,
    initialState: SecretViewState,
    groupInitialized: boolean,
  ): void {
    this.close("replace");

    const host = document.createElement("div");
    host.className = "secret-vault-popover-root";
    host.style.width = `${Math.min(POPOVER_WIDTH, window.innerWidth - POPOVER_MARGIN * 2)}px`;
    positionPopover(host, anchor.rect);
    document.body.appendChild(host);

    const app = mount(SecretPopover, {
      target: host,
      props: {
        initialState,
        groupInitialized,
        unlock: async (password: string) => {
          await this.vault.unlockGroup(anchor.contextId, initialState.groupId, password);
          return this.vault.getSecretView(anchor.contextId, initialState.secretId);
        },
        save: async (label: string, content: string) => {
          await this.vault.updateSecret(anchor.contextId, initialState.secretId, label, content);
          const currentSecret = this.vault.getSecret(initialState.secretId);
          if (!currentSecret) throw new Error("秘密保存后无法重新读取");
          const currentGroup = this.vault.getGroup(currentSecret.groupId);
          if (!currentGroup) throw new Error("秘密所属分组不存在");

          let snapshotWarning: string | undefined;
          try {
            await this.references.refreshSnapshot(anchor.blockId, currentSecret, currentGroup.name);
          } catch (error) {
            snapshotWarning = `秘密已保存，但当前文档引用未刷新：${errorMessage(error)}`;
          }

          return {
            state: await this.vault.getSecretView(anchor.contextId, initialState.secretId),
            snapshotWarning,
          };
        },
        copy: async () => {
          const content = await this.vault.readSecret(anchor.contextId, initialState.secretId);
          await navigator.clipboard.writeText(content);
        },
        lock: () => this.vault.lockGroup(anchor.contextId, initialState.groupId),
        close: () => this.close("user"),
      },
    });

    this.active = {
      host,
      app,
      secretId: initialState.secretId,
      groupId: initialState.groupId,
      contextId: anchor.contextId,
      blockId: anchor.blockId,
    };

    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    // A click into the background closes the panel, but there is no backdrop and
    // the editor receives the same pointer event normally.
    document.addEventListener("pointerdown", this.handleOutsidePointerDown, true);
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.close("escape");
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.host.contains(event.target as Node)) return;
    this.close("outside-click");
  };

  private readonly handleRevocation = (revocation: AuthorizationRevocation): void => {
    const active = this.active;
    if (!active || !revokesActivePopover(revocation, active)) return;
    this.close(`revoked:${revocation.reason}`);
  };
}

function findPluginLink(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : null;
  return element?.closest<HTMLElement>('[data-type="a"][data-href]') ?? null;
}

function positionPopover(host: HTMLElement, anchor: DOMRect): void {
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - POPOVER_MARGIN * 2);
  const left = clamp(anchor.left, POPOVER_MARGIN, window.innerWidth - width - POPOVER_MARGIN);

  const belowTop = anchor.bottom + 8;
  const hasRoomBelow = window.innerHeight - belowTop >= POPOVER_HEIGHT_ESTIMATE;
  const top = hasRoomBelow
    ? belowTop
    : Math.max(POPOVER_MARGIN, anchor.top - POPOVER_HEIGHT_ESTIMATE - 8);

  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

function revokesActivePopover(
  revocation: AuthorizationRevocation,
  active: Pick<ActivePopover, "contextId" | "groupId" | "secretId">,
): boolean {
  switch (revocation.scope) {
    case "all":
      return true;
    case "context":
      return revocation.contextId === active.contextId;
    case "group":
      return revocation.groupId === active.groupId;
    case "context-group":
      return revocation.contextId === active.contextId && revocation.groupId === active.groupId;
    case "secret":
      return revocation.secretId === active.secretId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
