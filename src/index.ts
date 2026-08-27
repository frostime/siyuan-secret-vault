import {
  Plugin,
  openTab,
  showMessage,
  type Custom,
  type Protyle,
} from "siyuan";
import { mount, unmount } from "svelte";
import { EmbedSessionBroker } from "./embed/broker";
import { ProtyleContextRegistry } from "./editor/protyle-context";
// import { SecretBlockHeightController } from "./editor/secret-block-height";
import { SecretDialogs } from "./editor/secret-dialogs";
import { SecretReferenceService } from "./editor/secret-reference";
import { LegacyReferenceV1ToV2Migration } from "./migrations/legacy-reference-v1-to-v2";
import type { MigrationTask } from "./migrations/types";
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
  private migrationTasks: MigrationTask[] = [];
  private broker: EmbedSessionBroker | null = null;

  async onload(): Promise<void> {
    this.addSecretVaultIcon();

    this.vault = new VaultController(this);
    this.contexts = new ProtyleContextRegistry();
    this.references = new SecretReferenceService(this.name);
    this.dialogs = new SecretDialogs(this.vault, this.references, this.contexts);
    this.migrationTasks = [
      new LegacyReferenceV1ToV2Migration(this.name, this.vault, this.references),
    ];

    // Register UI/editor integrations before the first await. SiYuan may restore
    // tabs and Protyles while plugin data is still loading.
    this.registerVaultTab();
    this.registerEditorEvents();
    this.registerSlashCommands();

    // Install the handshake listener before awaiting plugin data. Dormant
    // references still do nothing until the user clicks Connect; this only
    // prevents that explicit click from being lost during a slow startup.
    const vaultReady = this.vault.initialize();

    this.broker = new EmbedSessionBroker(this.vault, {
      resolveSessionSource: async (source, secretId) => {
        const resolved = this.contexts.resolveEmbed(source);
        if (!resolved) return null;
        if (!(await this.references.matchesReference(resolved.blockId, secretId))) return null;

        try {
          this.vault.activateContext(resolved.contextId);
          return { contextId: resolved.contextId, blockId: resolved.blockId };
        } catch {
          // A late explicit connect from a Protyle already torn down must not
          // resurrect its released access context.
          return null;
        }
      },
      requestUnlock: (contextId, groupId) => this.dialogs.requestUnlock(contextId, groupId),
    }, vaultReady);
    this.broker.start();

    // Optional kernel-owned height capability is implemented and type-checked
    // in editor/secret-block-height.ts, but intentionally disconnected in 0.4.x.
    // const blockHeights = new SecretBlockHeightController();
    // (No live-session presentation edge is wired to blockHeights yet.)

    try {
      await vaultReady;
    } catch (error) {
      this.broker.dispose();
      this.broker = null;
      throw error;
    }
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

    // Broker disposal revokes only sessions that were explicitly connected.
    // Dormant document references are inert and are not contacted at all.
    this.broker?.dispose();
    this.broker = null;
    this.vault?.dispose();
  }

  uninstall(): void {
    // Vault data is intentionally retained. Uninstalling for troubleshooting or
    // reinstalling the same plugin must not implicitly destroy encrypted user
    // data or rewrite document references. Permanent data deletion should be an
    // explicit Vault action, not a plugin lifecycle side effect.
  }

  async onDataChanged(): Promise<void> {
    await this.vault.reloadFromStorage();
    showMessage("秘密库同步数据已更新；运行中的 Secret 会话已断开，分组授权已清除");
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
            migrationTasks: plugin.migrationTasks,
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
          this.captureContext(protyle);
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
          this.captureContext(protyle);
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
    if (protyle) this.captureContext(protyle);
  };

  private readonly destroyProtyle = (
    event: CustomEvent<{ protyle?: Protyle }>,
  ): void => {
    const protyle = event.detail?.protyle;
    if (!protyle) return;

    const contextId = this.contexts.release(protyle);
    if (contextId) this.vault.releaseContext(contextId);
  };

  private captureContext(protyle: Protyle): void {
    const contextId = this.contexts.capture(protyle);
    this.vault.activateContext(contextId);
  }

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
    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("秘密所属分组不存在");

    await this.references.insertAtCaret(secret, group.name, protyle);
  }
}
