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
import {
  deleteBlock,
  getBlockKramdown,
  insertMarkdownBlock,
  setBlockAttrs,
  type BlockInsertionTarget,
} from "./api";
import "./index.scss";

const TAB_TYPE = "secret-vault";
const ICON = "iconSecretVault";

type SvelteApp = ReturnType<typeof mount>;

type SlashTarget = {
  target: BlockInsertionTarget;
  cleanupBlockId: string | null;
};

export default class SecretVaultPlugin extends Plugin {
  private controller!: VaultController;
  private broker!: EmbedBroker;
  private customTab!: () => Custom;
  private lastProtyle: Protyle | null = null;
  private brokerUnsubscribe: (() => void) | null = null;
  private readonly protyleIds = new WeakMap<Protyle, string>();
  private readonly sourceProtyleIds = new WeakMap<Window, string>();
  private readonly sourceFrames = new WeakMap<Window, HTMLIFrameElement>();
  private readonly unlockRequests = new Map<string, Promise<boolean>>();

  async onload(): Promise<void> {
    this.addIcons(`
      <symbol id="${ICON}" viewBox="0 0 32 32">
        <path d="M24 13h-1V9a7 7 0 0 0-14 0v4H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V16a3 3 0 0 0-3-3Zm-12-4a4 4 0 0 1 8 0v4h-8V9Zm5.5 12.7V25h-3v-3.3a3 3 0 1 1 3 0Z"/>
      </symbol>
    `);

    this.controller = new VaultController(this, (secretId) => this.insertSecretReference(secretId));

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
    this.eventBus.on("destroy-protyle", this.destroyProtyle);

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
          this.lastProtyle = protyle;
          const slashTarget = this.captureSlashTarget(protyle, nodeElement);
          this.openCreateSecretDialog(protyle, slashTarget);
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
          this.lastProtyle = protyle;
          const slashTarget = this.captureSlashTarget(protyle, nodeElement);
          this.openSecretPicker(protyle, slashTarget);
        },
      },
    ];

    await this.controller.initialize();

    this.broker = new EmbedBroker(
      this.controller,
      (groupId, groupName, initialized, protyleLeaseId) =>
        this.requestUnlock(groupId, groupName, initialized, protyleLeaseId),
      (source) => this.resolveProtyleLeaseForWindow(source),
      (source, height) => this.resizeEmbedForWindow(source, height),
    );
    this.broker.start();
    this.brokerUnsubscribe = this.controller.subscribe(
      (_snapshot, invalidation) => this.broker.invalidate(invalidation),
    );
  }

  onLayoutReady(): void {
    this.addTopBar({
      id: "secret-vault-topbar",
      icon: ICON,
      title: "秘密库",
      position: "right",
      callback: () => this.openVault(null),
    });
  }

  async onunload(): Promise<void> {
    this.eventBus.off("switch-protyle", this.captureProtyle);
    this.eventBus.off("loaded-protyle-static", this.captureProtyle);
    this.eventBus.off("destroy-protyle", this.destroyProtyle);
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
    const protyle = event.detail?.protyle;
    if (!protyle) return;
    this.lastProtyle = protyle;
    this.ensureProtyleId(protyle);
  };

  private readonly destroyProtyle = (event: CustomEvent<{ protyle?: Protyle }>): void => {
    const protyle = event.detail?.protyle;
    if (!protyle) return;
    const protyleId = this.protyleIds.get(protyle);
    if (protyleId) this.controller.releaseProtyle(protyleId);
    if (this.lastProtyle === protyle) this.lastProtyle = null;
  };

  private openVault(secretId: string | null): void {
    this.controller.focusSecret(secretId);
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

  private getTargetProtyle(): Protyle | null {
    const editors = getAllEditor();
    if (this.lastProtyle?.block?.rootID && editors.includes(this.lastProtyle)) {
      return this.lastProtyle;
    }
    for (let i = editors.length - 1; i >= 0; i--) {
      if (editors[i]?.block?.rootID) return editors[i];
    }
    return null;
  }

  private async insertSecretReference(secretId: string): Promise<void> {
    const protyle = this.getTargetProtyle();
    if (!protyle) throw new Error("没有可插入的文档编辑器，请先打开一个文档");
    const target = this.resolveEditorInsertionTarget(protyle);
    await this.insertSecretReferenceInto(secretId, protyle, target);
  }

  private async insertSecretReferenceInto(
    secretId: string,
    _protyle: Protyle,
    target: BlockInsertionTarget,
    cleanupBlockId: string | null = null,
  ): Promise<void> {
    const secret = this.controller.getSecret(secretId);
    if (!secret) throw new Error("秘密不存在");

    const src = `/plugins/${this.name}/embed/index.html?secret=${encodeURIComponent(secret.id)}`;
    const iframe = `<iframe src="${src}" style="width: 100%; height: 54px; border: 0; border-radius: 6px;"></iframe>`;

    const inserted = await insertMarkdownBlock(iframe, target);

    if (inserted.dom && !inserted.dom.includes('data-type="NodeIFrame"')) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源没有把嵌入内容解析为 IFrame 块；已回滚此次插入");
    }

    try {
      await setBlockAttrs(inserted.id, {
        "custom-secret-vault": "1",
        "custom-secret-id": secret.id,
        "custom-secret-group": secret.groupId,
        "custom-secret-version": "1",
      });
    } catch (error) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw error;
    }

    if (cleanupBlockId) await this.cleanupSlashBlock(cleanupBlockId);
    showMessage(`已插入秘密：${secret.label}`);
  }

  private captureSlashTarget(protyle: Protyle, nodeElement: HTMLElement): SlashTarget {
    const anchorBlockId = nodeElement.dataset.nodeId || null;
    if (!anchorBlockId) {
      return {
        cleanupBlockId: null,
        target: this.resolveEditorInsertionTarget(protyle),
      };
    }

    const editable = nodeElement.querySelector<HTMLElement>('[contenteditable="true"]');
    const text = (editable?.textContent ?? nodeElement.textContent ?? "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
    const isSlashOnlyParagraph = /^\/\S*$/.test(text);

    return {
      cleanupBlockId: isSlashOnlyParagraph ? anchorBlockId : null,
      target: isSlashOnlyParagraph
        ? { nextID: anchorBlockId }
        : { previousID: anchorBlockId },
    };
  }

  private async cleanupSlashBlock(blockId: string): Promise<void> {
    try {
      const kramdown = await getBlockKramdown(blockId);
      const source = kramdown
        .replace(/\n?\{:[\s\S]*$/, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim();

      if (/^\/\S*$/.test(source)) {
        await deleteBlock(blockId);
      }
    } catch (error) {
      console.warn("[secret-vault] failed to clean slash source block", blockId, error);
    }
  }

  private resolveEditorInsertionTarget(protyle: Protyle): BlockInsertionTarget {
    const selection = globalThis.getSelection?.();
    const anchorNode = selection?.anchorNode ?? null;
    const element = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
    const selectedBlock = element?.closest<HTMLElement>("[data-node-id]");

    if (selectedBlock?.dataset.nodeId && protyle.wysiwyg.element.contains(selectedBlock)) {
      return { previousID: selectedBlock.dataset.nodeId };
    }
    if (protyle.block?.rootID) return { parentID: protyle.block.rootID };
    throw new Error("无法确定插入位置");
  }

  private openSecretPicker(protyle: Protyle, slashTarget: SlashTarget): void {
    const snapshot = this.controller.getSnapshot();
    const groups = new Map(snapshot.groups.map((group) => [group.id, group.name]));

    const dialog = new Dialog({
      title: "插入秘密",
      width: "580px",
      content: `
        <div class="b3-dialog__content secret-vault-picker">
          <button class="b3-button b3-button--text fn__block" type="button" data-secret-picker-create>+ 新建秘密并插入</button>
          <div class="secret-vault-picker__separator"></div>
          <input class="b3-text-field fn__block" type="search" autocomplete="off" placeholder="按 label 或分组搜索已有秘密…" data-secret-picker-search />
          <div class="secret-vault-picker__list" data-secret-picker-list></div>
          <div class="secret-vault-picker__empty fn__none" data-secret-picker-empty>没有匹配的秘密。</div>
        </div>`,
    });

    const create = dialog.element.querySelector<HTMLButtonElement>("[data-secret-picker-create]")!;
    const search = dialog.element.querySelector<HTMLInputElement>("[data-secret-picker-search]")!;
    const list = dialog.element.querySelector<HTMLElement>("[data-secret-picker-list]")!;
    const empty = dialog.element.querySelector<HTMLElement>("[data-secret-picker-empty]")!;

    create.addEventListener("click", () => {
      dialog.destroy();
      this.openCreateSecretDialog(protyle, slashTarget);
    });

    const render = () => {
      const q = search.value.trim().toLowerCase();
      const matches = snapshot.secrets.filter((secret) => {
        const groupName = groups.get(secret.groupId) ?? secret.groupId;
        return !q
          || secret.label.toLowerCase().includes(q)
          || groupName.toLowerCase().includes(q);
      });

      list.replaceChildren();
      empty.classList.toggle("fn__none", matches.length > 0);

      for (const secret of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "b3-list-item b3-list-item--two";
        button.dataset.secretId = secret.id;

        const first = document.createElement("span");
        first.className = "b3-list-item__first";

        const text = document.createElement("span");
        text.className = "b3-list-item__text";
        text.textContent = secret.label;
        first.appendChild(text);

        const meta = document.createElement("span");
        meta.className = "b3-list-item__meta";
        meta.textContent = groups.get(secret.groupId) ?? secret.groupId;

        button.append(first, meta);

        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await this.insertSecretReferenceInto(
              secret.id,
              protyle,
              slashTarget.target,
              slashTarget.cleanupBlockId,
            );
            dialog.destroy();
          } catch (error) {
            button.disabled = false;
            showMessage(
              error instanceof Error ? error.message : String(error),
              5000,
              "error",
            );
          }
        });

        list.appendChild(button);
      }
    };

    search.addEventListener("input", render);
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const first = list.querySelector<HTMLButtonElement>("button:not(:disabled)");
        first?.click();
      }
    });

    render();
    setTimeout(() => search.focus(), 0);
  }

  private openCreateSecretDialog(protyle: Protyle, slashTarget: SlashTarget): void {
    const snapshot = this.controller.getSnapshot();
    if (snapshot.groups.length === 0) {
      showMessage("没有可用分组", 5000, "error");
      return;
    }

    const groupOptions = snapshot.groups
      .map((group) => (
        `<option value="${this.escapeHtml(group.id)}">`
        + `${this.escapeHtml(group.name)}`
        + `${group.unlocked ? " · 已解锁" : " · 已锁定"}`
        + "</option>"
      ))
      .join("");

    const dialog = new Dialog({
      title: "新建秘密并插入",
      width: "620px",
      content: `
        <div class="b3-dialog__content secret-vault-create-inline">
          <label>
            <span>分组</span>
            <select class="b3-select fn__block" data-secret-create-group>${groupOptions}</select>
          </label>
          <label>
            <span>Label（明文）</span>
            <input class="b3-text-field fn__block" type="text" autocomplete="off" placeholder="例如：GitHub Token" data-secret-create-label />
          </label>
          <label>
            <span>Content（加密）</span>
            <textarea class="b3-text-field fn__block" rows="10" spellcheck="false" placeholder="要加密保存的内容" data-secret-create-content></textarea>
          </label>
          <div class="secret-vault-create-inline__hint">
            若所选分组尚未解锁，保存时会要求输入该分组口令；口令不会持久化。
          </div>
          <div data-secret-create-error class="vault-error fn__none"></div>
        </div>
        <div class="b3-dialog__action">
          <button class="b3-button b3-button--cancel" data-secret-create-cancel>取消</button>
          <button class="b3-button b3-button--text" data-secret-create-ok>创建并插入</button>
        </div>`,
    });

    const groupSelect = dialog.element.querySelector<HTMLSelectElement>("[data-secret-create-group]")!;
    const labelInput = dialog.element.querySelector<HTMLInputElement>("[data-secret-create-label]")!;
    const contentInput = dialog.element.querySelector<HTMLTextAreaElement>("[data-secret-create-content]")!;
    const error = dialog.element.querySelector<HTMLElement>("[data-secret-create-error]")!;
    const ok = dialog.element.querySelector<HTMLButtonElement>("[data-secret-create-ok]")!;
    const cancel = dialog.element.querySelector<HTMLButtonElement>("[data-secret-create-cancel]")!;

    const submit = async () => {
      const group = this.controller
        .getSnapshot()
        .groups
        .find((item) => item.id === groupSelect.value);

      if (!group) {
        this.setInlineError(error, "分组不存在");
        return;
      }

      const label = labelInput.value.trim();
      if (!label) {
        this.setInlineError(error, "label 不能为空");
        labelInput.focus();
        return;
      }

      ok.disabled = true;
      this.setInlineError(error, "");

      try {
        if (!this.controller.isGroupUnlocked(group.id)) {
          const unlocked = await this.requestUnlock(
            group.id,
            group.name,
            group.initialized,
            this.ensureProtyleId(protyle),
          );
          if (!unlocked) return;
        }

        const secretId = await this.controller.createSecret(
          group.id,
          label,
          contentInput.value,
        );

        await this.insertSecretReferenceInto(
          secretId,
          protyle,
          slashTarget.target,
          slashTarget.cleanupBlockId,
        );

        dialog.destroy();
      } catch (createError) {
        this.setInlineError(
          error,
          createError instanceof Error ? createError.message : String(createError),
        );
      } finally {
        ok.disabled = false;
      }
    };

    ok.addEventListener("click", () => void submit());
    cancel.addEventListener("click", () => dialog.destroy());

    labelInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        void submit();
      }
    });

    contentInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        void submit();
      }
    });

    setTimeout(() => labelInput.focus(), 0);
  }

  private setInlineError(element: HTMLElement, message: string): void {
    element.textContent = message;
    element.classList.toggle("fn__none", !message);
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private ensureProtyleId(protyle: Protyle): string {
    let id = this.protyleIds.get(protyle);
    if (!id) {
      id = `protyle_${crypto.randomUUID()}`;
      this.protyleIds.set(protyle, id);
    }
    return id;
  }

  private findFrameForWindow(source: Window): HTMLIFrameElement | null {
    const cached = this.sourceFrames.get(source);

    if (cached?.isConnected && cached.contentWindow === source) {
      return cached;
    }

    if (cached) {
      this.sourceFrames.delete(source);
    }

    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
      if (frame.contentWindow === source) {
        this.sourceFrames.set(source, frame);
        return frame;
      }
    }

    return null;
  }

  private resolveProtyleLeaseForWindow(source: Window): string | null {
    const cached = this.sourceProtyleIds.get(source);
    if (cached) return cached;

    const sourceFrame = this.findFrameForWindow(source);
    if (!sourceFrame) return null;

    for (const protyle of getAllEditor()) {
      if (protyle.wysiwyg?.element?.contains(sourceFrame)) {
        const protyleId = this.ensureProtyleId(protyle);
        this.sourceProtyleIds.set(source, protyleId);
        return protyleId;
      }
    }

    return null;
  }

  private resizeEmbedForWindow(source: Window, requestedHeight: number): void {
    const frame = this.findFrameForWindow(source);
    if (!frame) return;

    const block = frame.closest<HTMLElement>('[data-type="NodeIFrame"]');
    if (!block) return;

    // Defensive bounds: an embed must not be able to create an
    // effectively unbounded Protyle block.
    const height = Math.round(
      Math.max(42, Math.min(420, requestedHeight)),
    );
    const cssHeight = `${height}px`;

    // NodeIFrame controls the vertical space occupied in Protyle.
    // The inner iframe must follow the same height so its viewport
    // matches the outer editor block.
    //
    // Compare inline styles directly instead of getBoundingClientRect():
    // this avoids an unnecessary forced layout in the parent document.
    if (
      block.style.height === cssHeight
      && frame.style.height === cssHeight
    ) {
      return;
    }

    block.style.height = cssHeight;
    frame.style.height = cssHeight;
  }

  private requestUnlock(
    groupId: string,
    groupName: string,
    initialized: boolean,
    protyleLeaseId?: string,
  ): Promise<boolean> {
    if (this.controller.isGroupUnlocked(groupId)) {
      if (protyleLeaseId) {
        this.controller.registerProtyleUse(groupId, protyleLeaseId);
      }
      return Promise.resolve(true);
    }

    let flight = this.unlockRequests.get(groupId);

    if (!flight) {
      flight = this.openUnlockDialog(
        groupId,
        groupName,
        initialized,
        protyleLeaseId,
      ).finally(() => this.unlockRequests.delete(groupId));

      this.unlockRequests.set(groupId, flight);
    }

    return flight.then((unlocked) => {
      if (unlocked && protyleLeaseId) {
        this.controller.markGroupProtyleScoped(groupId, protyleLeaseId);
      }
      return unlocked;
    });
  }

  private openUnlockDialog(
    groupId: string,
    groupName: string,
    initialized: boolean,
    protyleLeaseId?: string,
  ): Promise<boolean> {
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
              <span>
                ${initialized
                  ? "输入该分组口令"
                  : "该分组尚未设置口令；本次输入将成为其口令"}
              </span>
              <input class="b3-text-field fn__block" type="password" autocomplete="current-password" data-secret-password />
            </label>
            <div
              data-secret-error
              style="margin-top:8px;color:var(--b3-card-error-color);min-height:20px"
            ></div>
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
          await this.controller.unlockGroup(
            groupId,
            password,
            protyleLeaseId,
          );

          input.value = "";
          finish(true);
          dialog.destroy();
        } catch (unlockError) {
          input.value = "";
          input.focus();
          error.textContent = unlockError instanceof Error
            ? unlockError.message
            : String(unlockError);
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
