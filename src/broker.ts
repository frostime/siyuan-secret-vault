import { showMessage } from "siyuan";
import type { VaultController } from "./vault";
import { isEmbedRequest, PROTOCOL_NS, PROTOCOL_VERSION, type EmbedResponse } from "./protocol";

export class EmbedBroker {
  private readonly channel = new BroadcastChannel("siyuan-secret-vault:events");
  private disposed = false;

  constructor(
    private readonly vault: VaultController,
    private readonly requestUnlock: (groupId: string, groupName: string, initialized: boolean) => Promise<boolean>,
    private readonly openVault: (secretId: string) => void,
  ) {}

  start(): void {
    window.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("message", this.onMessage);
    this.channel.close();
  }

  invalidateAll(): void {
    const message: EmbedResponse = {
      ns: PROTOCOL_NS,
      v: PROTOCOL_VERSION,
      type: "invalidate",
      ok: true,
    };
    this.channel.postMessage(message);
  }

  private readonly onMessage = async (event: MessageEvent): Promise<void> => {
    if (this.disposed || event.origin !== window.location.origin || !isEmbedRequest(event.data)) return;
    const source = event.source as Window | null;
    if (!source || typeof source.postMessage !== "function") return;
    const request = event.data;
    const respond = (response: Omit<EmbedResponse, "ns" | "v" | "requestId" | "type">) => {
      source.postMessage({
        ns: PROTOCOL_NS,
        v: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "response",
        ...response,
      } satisfies EmbedResponse, event.origin);
    };

    try {
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

      if (request.type === "secret:get-state") {
        respond({
          ok: true,
          data: {
            secretId: secret.id,
            label: secret.label,
            groupId: group.id,
            groupName: group.name,
            locked: !this.vault.isGroupUnlocked(group.id),
          },
        });
        return;
      }

      if (request.type === "secret:open-vault") {
        this.openVault(secret.id);
        respond({ ok: true });
        return;
      }

      if (request.type === "secret:lock-group") {
        this.vault.lockGroup(group.id);
        respond({ ok: true });
        return;
      }

      if (!this.vault.isGroupUnlocked(group.id)) {
        const unlocked = await this.requestUnlock(group.id, group.name, Boolean(group.verifier));
        if (!unlocked) {
          respond({ ok: false, error: "已取消解锁" });
          return;
        }
      }

      if (request.type === "secret:reveal") {
        respond({ ok: true, data: { content: await this.vault.readSecret(secret.id) } });
        return;
      }

      if (request.type === "secret:copy") {
        await navigator.clipboard.writeText(await this.vault.readSecret(secret.id));
        showMessage(`已复制：${secret.label}`);
        respond({ ok: true });
        return;
      }

      respond({ ok: false, error: "不支持的操作" });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
