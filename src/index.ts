import {
  Dialog,
  Plugin,
  Protyle,
  getAllEditor,
  openTab,
  showMessage,
  type Custom,
} from "siyuan";
import { mount, unmount } from "svelte";
import VaultApp from "./ui/VaultApp.svelte";
import { VaultController } from "./vault";
import { EmbedBroker } from "./broker";
import "./index.scss";

const TAB_TYPE = "secret-vault";
const ICON = "iconSecretVault";

type SvelteApp = ReturnType<typeof mount>;

export default class SecretVaultPlugin extends Plugin {
  private controller!: VaultController;
  private broker!: EmbedBroker;
  private customTab!: () => Custom;
  private lastProtyle: Protyle | null = null;
  private brokerUnsubscribe: (() => void) | null = null;

  async onload(): Promise<void> {
    this.addIcons(`
      <symbol id="${ICON}" viewBox="0 0 32 32">
        <path d="M24 13h-1V9a7 7 0 0 0-14 0v4H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V16a3 3 0 0 0-3-3Zm-12-4a4 4 0 0 1 8 0v4h-8V9Zm5.5 12.7V25h-3v-3.3a3 3 0 1 1 3 0Z"/>
      </symbol>
    `);

    this.controller = new VaultController(this, (secretId) => this.insertSecretReference(secretId));
    await this.controller.initialize();

    this.broker = new EmbedBroker(
      this.controller,
      (groupId, groupName, initialized) => this.requestUnlock(groupId, groupName, initialized),
      (secretId) => this.openVault(secretId),
    );
    this.broker.start();
    this.brokerUnsubscribe = this.controller.subscribe(() => this.broker.invalidateAll());

    const plugin = this;
    this.customTab = this.addTab({
      type: TAB_TYPE,
      init() {
        const host = document.createElement("div");
        host.className = "secret-vault-tab";
        this.element.appendChild(host);
        (this as Custom & { __secretVaultApp?: SvelteApp }).__secretVaultApp = mount(VaultApp, {
          target: host,
          props: { controller: plugin.controller },
        });
      },
      destroy() {
        const app = (this as Custom & { __secretVaultApp?: SvelteApp }).__secretVaultApp;
        if (app) unmount(app);
      },
    });

    this.eventBus.on("switch-protyle", this.captureProtyle);
    this.eventBus.on("loaded-protyle-static", this.captureProtyle);

  }

  onLayoutReady(): void {
    this.addTopBar({
      icon: ICON,
      title: "秘密库",
      position: "right",
      callback: () => this.openVault(null),
    });
  }

  async onunload(): Promise<void> {
    this.eventBus.off("switch-protyle", this.captureProtyle);
    this.eventBus.off("loaded-protyle-static", this.captureProtyle);
    this.brokerUnsubscribe?.();
    this.brokerUnsubscribe = null;
    this.broker?.dispose();
    this.controller?.lockAll();
  }

  async onDataChanged(): Promise<void> {
    await this.controller.reloadFromStorage();
    showMessage("秘密库同步数据已更新；所有分组已重新锁定");
  }

  private readonly captureProtyle = (event: CustomEvent<{ protyle?: Protyle }>): void => {
    if (event.detail?.protyle) this.lastProtyle = event.detail.protyle;
  };

  private openVault(secretId: string | null): void {
    this.controller.focusSecret(secretId);
    openTab({
      app: this.app,
      custom: {
        icon: ICON,
        title: "秘密库",
        data: {},
        id: `${this.name}-${TAB_TYPE}`,
      },
    });
  }

  private getTargetProtyle(): Protyle | null {
    const editors = getAllEditor();
    if (this.lastProtyle?.block?.rootID && editors.some((editor) => editor?.protyle === this.lastProtyle)) {
      return this.lastProtyle;
    }
    for (let i = editors.length - 1; i >= 0; i--) {
      if (editors[i]?.protyle?.block?.rootID) return editors[i].protyle ?? null;
    }
    return null;
  }

  private async insertSecretReference(secretId: string): Promise<void> {
    const secret = this.controller.getSecret(secretId);
    if (!secret) throw new Error("秘密不存在");
    const protyle = this.getTargetProtyle();
    if (!protyle) throw new Error("没有可插入的文档编辑器，请先打开一个文档");

    const src = `/plugins/${this.name}/embed/index.html?secret=${encodeURIComponent(secret.id)}`;
    const iframe = `<iframe src="${src}" style="width: 100%; height: 180px; border: 0; border-radius: 8px;"></iframe>`;
    const ial = `{: custom-secret-vault="1" custom-secret-id="${secret.id}" custom-secret-group="${secret.groupId}"}`;
    protyle.insert(`${iframe}\n${ial}`);
    showMessage(`已插入秘密引用：${secret.label}`);
  }

  private requestUnlock(groupId: string, groupName: string, initialized: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const dialog = new Dialog({
        title: initialized ? `解锁 ${groupName}` : `为 ${groupName} 设置口令`,
        width: "420px",
        content: `
          <div class="b3-dialog__content">
            <label class="fn__flex-column" style="gap:8px">
              <span>${initialized ? "输入该分组口令" : "该分组尚未设置口令；本次输入将成为其口令"}</span>
              <input class="b3-text-field fn__block" type="password" autocomplete="current-password" data-secret-password />
            </label>
            <div data-secret-error style="margin-top:8px;color:var(--b3-card-error-color);min-height:20px"></div>
          </div>
          <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel" data-secret-cancel>取消</button>
            <button class="b3-button b3-button--text" data-secret-ok>确定</button>
          </div>`,
        destroyCallback: () => finish(false),
      });

      const input = dialog.element.querySelector<HTMLInputElement>("[data-secret-password]")!;
      const ok = dialog.element.querySelector<HTMLButtonElement>("[data-secret-ok]")!;
      const cancel = dialog.element.querySelector<HTMLButtonElement>("[data-secret-cancel]")!;
      const error = dialog.element.querySelector<HTMLElement>("[data-secret-error]")!;

      const submit = async () => {
        const password = input.value;
        if (!password) {
          error.textContent = "口令不能为空";
          return;
        }
        ok.disabled = true;
        error.textContent = "";
        try {
          await this.controller.unlockGroup(groupId, password);
          input.value = "";
          finish(true);
          dialog.destroy();
        } catch (unlockError) {
          input.value = "";
          input.focus();
          error.textContent = unlockError instanceof Error ? unlockError.message : String(unlockError);
        } finally {
          ok.disabled = false;
        }
      };
      ok.addEventListener("click", submit);
      cancel.addEventListener("click", () => dialog.destroy());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void submit();
      });
      setTimeout(() => input.focus(), 0);
    });
  }
}
