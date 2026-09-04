import {
  Plugin,
  openTab,
  showMessage,
  type Custom,
  type Protyle,
} from "siyuan";
import { mount, unmount } from "svelte";
import { EditorContextRegistry } from "./interaction/editor-context";
import { SecretInteractionController } from "./interaction/secret-interaction";
import { SecretDialogs } from "./editor/secret-dialogs";
import { ReferenceToParagraphMigration } from "./migrations/reference-to-paragraph";
import type { MigrationTask } from "./migrations/types";
import { SecretReferenceService } from "./reference/secret-reference";
import { VAULT_CONTEXT_ID } from "./types";
import VaultApp from "./ui/VaultApp.svelte";
import { VaultController } from "./vault";
import "./index.scss";

const TAB_TYPE = "secret-vault";
const ICON = "iconSecretVault";

type SvelteApp = ReturnType<typeof mount>;

/**
 * Runtime shape of the tab host that siyuan binds as `this` in addTab
 * callbacks. siyuan@1.2.6 dropped the `this: Custom` annotation on those
 * callbacks, so this type boundary names only the members the plugin
 * actually uses instead of asserting the whole Custom interface.
 */
interface VaultTabHost {
  element: HTMLElement;
  __secretVaultApp?: SvelteApp;
}

function asVaultTabHost(context: unknown): VaultTabHost {
  return context as VaultTabHost;
}

/** Composition root for SiYuan lifecycle and integration points. */
export default class SecretVaultPlugin extends Plugin {
  private vault!: VaultController;
  private contexts!: EditorContextRegistry;
  private references!: SecretReferenceService;
  private dialogs!: SecretDialogs;
  private interactions: SecretInteractionController | null = null;
  private migrationTasks: MigrationTask[] = [];

  async onload(): Promise<void> {
    this.addSecretVaultIcon();

    this.vault = new VaultController(this);
    this.contexts = new EditorContextRegistry();
    this.references = new SecretReferenceService(this.name);
    this.dialogs = new SecretDialogs(this.vault, this.references, this.contexts);
    this.migrationTasks = [
      new ReferenceToParagraphMigration(this.name, this.vault, this.references),
    ];

    // Register SiYuan-owned UI hooks synchronously. No document reference runs
    // plugin code merely because its document was opened.
    this.registerVaultTab();
    this.registerEditorEvents();
    this.registerSlashCommands();

    await this.vault.initialize();

    // The transient interaction adapter is global to the plugin, not one per
    // reference. It reacts only after an explicit click on our plugin link.
    this.interactions = new SecretInteractionController(
      this,
      this.vault,
      this.references,
      this.contexts,
    );
    this.interactions.start();
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
    this.interactions?.dispose();
    this.interactions = null;
    this.vault?.dispose();
  }

  uninstall(): void {
    // Encrypted Vault data and document references are user data. Plugin
    // uninstall/reinstall must not silently destroy either one. Legacy widget
    // files from pre-v4 references are likewise not deleted automatically;
    // document migration/cleanup remains an explicit maintenance operation.
  }

  async onDataChanged(): Promise<void> {
    await this.vault.reloadFromStorage();
    showMessage("秘密库同步数据已更新；运行中的明文交互已关闭，分组授权已清除");
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
        const tab = asVaultTabHost(this);
        const host = document.createElement("div");
        host.className = "secret-vault-tab";
        tab.element.appendChild(host);

        tab.__secretVaultApp = mount(VaultApp, {
          target: host,
          props: {
            vault: plugin.vault,
            contextId: VAULT_CONTEXT_ID,
            copySecretReference: (secretId: string) => plugin.copySecretReference(secretId),
            migrationTasks: plugin.migrationTasks,
          },
        });
      },
      destroy() {
        const app = asVaultTabHost(this).__secretVaultApp;
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
          "秘密",
          "mimi",
          "mm",
          "加密",
          "密"
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

  private async copySecretReference(secretId: string): Promise<void> {
    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("秘密不存在");

    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("秘密所属分组不存在");

    await this.references.copyToClipboard(secret, group.name);
  }
}
