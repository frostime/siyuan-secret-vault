import { showMessage } from "siyuan";
import type { AccessContextId, GroupId, VaultInvalidation } from "../types";
import type { VaultController } from "../vault";
import {
  isEmbedRequest,
  isEmbedResizeMessage,
  PROTOCOL_NS,
  PROTOCOL_VERSION,
  type EmbedInvalidationMessage,
  type EmbedResponse,
} from "./protocol";

export interface EmbedHost {
  resolveContext(source: Window): AccessContextId | null;
  requestUnlock(contextId: AccessContextId, groupId: GroupId): Promise<boolean>;
  resizeEmbed(source: Window, height: number): void;
}

/** Bridges the thin iframe UI to context-aware vault operations in the plugin. */
export class EmbedBroker {
  private readonly channel = new BroadcastChannel("siyuan-secret-vault:events");
  private disposed = false;

  constructor(
    private readonly vault: VaultController,
    private readonly host: EmbedHost,
  ) {}

  start(): void {
    window.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("message", this.onMessage);
    this.channel.close();
  }

  invalidate(invalidation: VaultInvalidation): void {
    const message: EmbedInvalidationMessage = {
      ns: PROTOCOL_NS,
      v: PROTOCOL_VERSION,
      type: "invalidate",
      invalidation,
    };
    this.channel.postMessage(message);
  }

  private readonly onMessage = async (event: MessageEvent): Promise<void> => {
    if (this.disposed || event.origin !== window.location.origin) return;

    const source = event.source as Window | null;
    if (!source || typeof source.postMessage !== "function") return;

    if (isEmbedResizeMessage(event.data)) {
      this.host.resizeEmbed(source, event.data.height);
      return;
    }

    if (!isEmbedRequest(event.data)) return;

    const request = event.data;
    const respond = (
      response: Omit<EmbedResponse, "ns" | "v" | "requestId" | "type">,
    ): void => {
      source.postMessage({
        ns: PROTOCOL_NS,
        v: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "response",
        ...response,
      } satisfies EmbedResponse, event.origin);
    };

    const contextId = this.host.resolveContext(source);
    if (!contextId) {
      respond({ ok: false, error: "无法识别当前 Secret 所属的文档编辑器" });
      return;
    }

    try {
      if (request.type === "secret:get-state") {
        respond({ ok: true, data: await this.vault.getSecretView(contextId, request.secretId) });
        return;
      }

      const secret = this.vault.getSecret(request.secretId);
      if (!secret) {
        respond({ ok: false, error: "秘密不存在或已被删除" });
        return;
      }

      const group = this.vault.getGroup(secret.groupId);
      if (!group) {
        respond({ ok: false, error: "秘密所属分组不存在" });
        return;
      }

      if (request.type === "secret:lock-group") {
        this.vault.lockGroup(contextId, group.id);
        respond({ ok: true });
        return;
      }

      if (!this.vault.isGroupUnlocked(contextId, group.id)) {
        const unlocked = await this.host.requestUnlock(contextId, group.id);
        if (!unlocked) {
          respond({ ok: false, error: "已取消解锁" });
          return;
        }
      }

      switch (request.type) {
        case "secret:reveal":
          respond({
            ok: true,
            data: { content: await this.vault.readSecret(contextId, secret.id) },
          });
          return;

        case "secret:copy":
          await navigator.clipboard.writeText(await this.vault.readSecret(contextId, secret.id));
          showMessage(`已复制：${secret.label}`);
          respond({ ok: true });
          return;

        case "secret:update":
          await this.vault.updateSecret(
            contextId,
            secret.id,
            request.data.label,
            request.data.content,
          );
          respond({ ok: true });
          return;
      }
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
