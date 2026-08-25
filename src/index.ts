import {
  Plugin,
  openTab,
  showMessage,
  type Custom,
  type Protyle,
} from "siyuan";
import { mount, unmount } from "svelte";
import { EmbedBroker } from "./embed/broker";
import { ProtyleContextRegistry } from "./editor/protyle-context";
import { SecretDialogs } from "./editor/secret-dialogs";
import { SecretReferenceService } from "./editor/secret-reference";
import { VAULT_CONTEXT_ID } from "./types";
import VaultApp from "./ui/VaultApp.svelte";
import { VaultController } from "./vault";
import "./index.scss";

const TAB_TYPE = "secret-vault";
const ICON = "iconSecretVault";

type SvelteApp = ReturnType<typeof mount>;

/** Composition root for SiYuan lifecycle and integration points. */
export default class SecretVaultPlugin extends Plugin {
  private vault!: VaultController;
  private contexts!: ProtyleContextRegistry;
  private references!: SecretReferenceService;
  private dialogs!: SecretDialogs;
  private broker: EmbedBroker | null = null;
  private unsubscribeInvalidations: (() => void) | null = null;

  async onload(): Promise<void> {
    this.addSecretVaultIcon();

    this.vault = new VaultController(this);
    this.contexts = new ProtyleContextRegistry(this.name);
    this.references = new SecretReferenceService(this.name);
    this.dialogs = new SecretDialogs(this.vault, this.references, this.contexts);

    // Register UI/editor integrations before the first await. SiYuan may restore
    // tabs and Protyles while plugin data is still loading.
    this.registerVaultTab();
    this.registerEditorEvents();
    this.registerSlashCommands();

    await this.vault.initialize();

    this.broker = new EmbedBroker(this.vault, {
      resolveContext: (source) => this.contexts.resolveEmbed(source)?.contextId ?? null,
      requestUnlock: (contextId, groupId) => this.dialogs.requestUnlock(contextId, groupId),
      resizeEmbed: (source, height) => this.contexts.resizeEmbed(source, height),
    });
    this.broker.start();
    this.unsubscribeInvalidations = this.vault.subscribeInvalidations(
      (invalidation) => this.broker?.invalidate(invalidation),
    );
  }

  onLayoutReady(): void {
    this.addTopBar({
      id: "secret-vault-topbar",
      icon: ICON,
      title: "秘密库",
      position: "right",
      callback: () => this.openVault(),
    });
  }

  onunload(): void {
    this.unregisterEditorEvents();
    this.unsubscribeInvalidations?.();
    this.unsubscribeInvalidations = null;
    this.broker?.dispose();
    this.broker = null;
    this.vault?.dispose();
  }

  async onDataChanged(): Promise<void> {
    await this.vault.reloadFromStorage();
    showMessage("秘密库同步数据已更新；所有窗口的分组授权已清除");
  }

  private addSecretVaultIcon(): void {
    this.addIcons(`
      <symbol id="${ICON}" viewBox="0 0 32 32">
        <path d="M24 13h-1V9a7 7 0 0 0-14 0v4H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V16a3 3 0 0 0-3-3Zm-12-4a4 4 0 0 1 8 0v4h-8V9Zm5.5 12.7V25h-3v-3.3a3 3 0 1 1 3 0Z"/>
      </symbol>
    `);
  }

  private registerVaultTab(): void {
    const plugin = this;

    this.addTab({
      type: TAB_TYPE,
      init() {
        const host = document.createElement("div");
        host.className = "secret-vault-tab";
        this.element.appendChild(host);

        (this as Custom & { __secretVaultApp?: SvelteApp }).__secretVaultApp = mount(VaultApp, {
          target: host,
          props: {
            vault: plugin.vault,
            contextId: VAULT_CONTEXT_ID,
            insertSecret: (secretId: string) => plugin.insertSecretFromVault(secretId),
          },
        });
      },
      destroy() {
        const app = (this as Custom & { __secretVaultApp?: SvelteApp }).__secretVaultApp;
        if (app) unmount(app);
      },
    });
  }

  private registerEditorEvents(): void {
    this.eventBus.on("switch-protyle", this.captureProtyle);
    this.eventBus.on("loaded-protyle-static", this.captureProtyle);
    this.eventBus.on("destroy-protyle", this.destroyProtyle);
  }

  private unregisterEditorEvents(): void {
    this.eventBus.off("switch-protyle", this.captureProtyle);
    this.eventBus.off("loaded-protyle-static", this.captureProtyle);
    this.eventBus.off("destroy-protyle", this.destroyProtyle);
  }

  private registerSlashCommands(): void {
    this.protyleSlash = [
      {
        filter: [
          "secret",
          "new secret",
          "create secret",
          "秘密",
          "新建秘密",
          "创建秘密",
          "加密内容",
        ],
        html: `<div class="b3-list-item__first"><span class="b3-list-item__text">新建秘密并插入</span><span class="b3-list-item__meta">🔐 +</span></div>`,
        id: "create-secret-and-insert",
        callback: (protyle: Protyle, nodeElement: HTMLElement) => {
          this.contexts.capture(protyle);
          this.dialogs.openCreateSecret(
            protyle,
            this.references.captureSlashTarget(protyle, nodeElement),
          );
        },
      },
      {
        filter: [
          "secret",
          "secret ref",
          "secret vault",
          "insert secret",
          "秘密引用",
          "秘密库",
          "插入秘密",
        ],
        html: `<div class="b3-list-item__first"><span class="b3-list-item__text">插入已有秘密</span><span class="b3-list-item__meta">🔐 ↗</span></div>`,
        id: "insert-secret-reference",
        callback: (protyle: Protyle, nodeElement: HTMLElement) => {
          this.contexts.capture(protyle);
          this.dialogs.openSecretPicker(
            protyle,
            this.references.captureSlashTarget(protyle, nodeElement),
          );
        },
      },
    ];
  }

  private readonly captureProtyle = (
    event: CustomEvent<{ protyle?: Protyle }>,
  ): void => {
    const protyle = event.detail?.protyle;
    if (protyle) this.contexts.capture(protyle);
  };

  private readonly destroyProtyle = (
    event: CustomEvent<{ protyle?: Protyle }>,
  ): void => {
    const protyle = event.detail?.protyle;
    if (!protyle) return;

    const contextId = this.contexts.release(protyle);
    if (contextId) this.vault.releaseContext(contextId);
  };

  private openVault(): void {
    openTab({
      app: this.app,
      custom: {
        icon: ICON,
        title: "秘密库",
        data: {},
        id: this.name + TAB_TYPE,
      },
    });
  }

  private async insertSecretFromVault(secretId: string): Promise<void> {
    const protyle = this.contexts.getTargetProtyle();
    if (!protyle) throw new Error("没有可插入的文档编辑器，请先打开一个文档");

    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("秘密不存在");

    await this.references.insertAtCaret(secret, protyle);
  }
}
