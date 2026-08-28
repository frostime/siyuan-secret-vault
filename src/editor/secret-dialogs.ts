import { Dialog, showMessage, type Protyle } from "siyuan";
import type { AccessContextId, GroupId } from "../types";
import type { VaultController } from "../vault";
import type { EditorContextRegistry } from "../interaction/editor-context";
import type { SecretReferenceService, SlashTarget } from "../reference/secret-reference";

/**
 * Owns the imperative SiYuan dialogs used from editor slash commands and
 * editor actions. Password prompts are single-flight per context +
 * group so several connected Secret frames cannot open duplicate dialogs.
 */
export class SecretDialogs {
  private readonly unlockFlights = new Map<string, Promise<boolean>>();

  constructor(
    private readonly vault: VaultController,
    private readonly references: SecretReferenceService,
    private readonly contexts: EditorContextRegistry,
  ) {}

  requestUnlock(contextId: AccessContextId, groupId: GroupId): Promise<boolean> {
    if (this.vault.isGroupUnlocked(contextId, groupId)) {
      return Promise.resolve(true);
    }

    const group = this.vault.getGroup(groupId);
    if (!group) return Promise.reject(new Error("分组不存在"));

    const flightKey = `${contextId}\u0000${groupId}`;
    let flight = this.unlockFlights.get(flightKey);

    if (!flight) {
      flight = this.openUnlockDialog(
        contextId,
        group.id,
        group.name,
        Boolean(group.verifier),
      ).finally(() => this.unlockFlights.delete(flightKey));
      this.unlockFlights.set(flightKey, flight);
    }

    return flight;
  }

  openSecretPicker(protyle: Protyle, slashTarget: SlashTarget): void {
    const contextId = this.contexts.contextFor(protyle);
    const snapshot = this.vault.getSnapshot(contextId);
    const groupNames = new Map(snapshot.groups.map((group) => [group.id, group.name]));

    const dialog = new Dialog({
      title: "插入已有秘密",
      width: "560px",
      content: `
        <div class="b3-dialog__content secret-vault-picker">
          <div class="secret-vault-picker__toolbar">
            <div class="secret-vault-picker__intro">
              <strong>选择已有秘密</strong>
              <span
                class="secret-vault-picker__count"
                data-secret-picker-count
              >${snapshot.secrets.length} 个秘密</span>
            </div>

            <button
              class="b3-button b3-button--text secret-vault-picker__create"
              type="button"
              data-secret-picker-create
            >+ 新建秘密</button>
          </div>

          <label class="secret-vault-picker__search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="m20.4 19-4.7-4.7a7 7 0 1 0-1.4 1.4l4.7 4.7a1 1 0 0 0 1.4-1.4ZM5 10a5 5 0 1 1 10 0 5 5 0 0 1-10 0Z"
              />
            </svg>

            <input
              class="b3-text-field"
              type="search"
              autocomplete="off"
              placeholder="搜索 label 或分组"
              data-secret-picker-search
            />
          </label>

          <div
            class="secret-vault-picker__list"
            data-secret-picker-list
          ></div>

          <div
            class="secret-vault-picker__empty fn__none"
            data-secret-picker-empty
          >没有匹配的秘密</div>
        </div>`,
    });

    const create = dialog.element.querySelector<HTMLButtonElement>(
      "[data-secret-picker-create]",
    )!;
    const search = dialog.element.querySelector<HTMLInputElement>(
      "[data-secret-picker-search]",
    )!;
    const list = dialog.element.querySelector<HTMLElement>(
      "[data-secret-picker-list]",
    )!;
    const empty = dialog.element.querySelector<HTMLElement>(
      "[data-secret-picker-empty]",
    )!;
    const count = dialog.element.querySelector<HTMLElement>(
      "[data-secret-picker-count]",
    )!;

    create.addEventListener("click", () => {
      dialog.destroy();
      this.openCreateSecret(protyle, slashTarget);
    });

    const render = () => {
      const query = search.value.trim().toLowerCase();
      const matches = snapshot.secrets.filter((secret) => {
        const groupName = groupNames.get(secret.groupId) ?? secret.groupId;

        return !query
          || secret.label.toLowerCase().includes(query)
          || groupName.toLowerCase().includes(query);
      });

      count.textContent = query
        ? `${matches.length} 个匹配 · 共 ${snapshot.secrets.length} 个`
        : `${snapshot.secrets.length} 个秘密`;

      list.replaceChildren();
      list.classList.toggle("fn__none", matches.length === 0);
      empty.classList.toggle("fn__none", matches.length > 0);

      for (const secret of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secret-vault-picker__item";
        button.title = `插入「${secret.label}」`;

        const label = document.createElement("span");
        label.className = "secret-vault-picker__item-label";
        label.textContent = secret.label;

        const group = document.createElement("span");
        group.className = "secret-vault-picker__item-group";
        group.textContent = groupNames.get(secret.groupId) ?? secret.groupId;

        const arrow = document.createElement("span");
        arrow.className = "secret-vault-picker__item-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "›";

        button.append(label, group, arrow);

        button.addEventListener("click", async () => {
          button.disabled = true;

          try {
            // The picker snapshot is intentionally static while the dialog is
            // open, but the selected Secret must still exist at commit time.
            const currentSecret = this.vault.getSecret(secret.id);
            if (!currentSecret) throw new Error("该秘密已被删除");

            const currentGroup = this.vault.getGroup(currentSecret.groupId);
            if (!currentGroup) throw new Error("秘密所属分组不存在");

            await this.references.insertFromSlash(
              currentSecret,
              currentGroup.name,
              slashTarget,
            );

            dialog.destroy();
          } catch (error) {
            button.disabled = false;
            showMessage(errorMessage(error), 5000, "error");
          }
        });

        list.appendChild(button);
      }
    };

    search.addEventListener("input", render);
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        list
          .querySelector<HTMLButtonElement>("button:not(:disabled)")
          ?.click();
      }
    });

    render();
    setTimeout(() => search.focus(), 0);
  }

  openCreateSecret(protyle: Protyle, slashTarget: SlashTarget): void {
    const contextId = this.contexts.contextFor(protyle);
    const snapshot = this.vault.getSnapshot(contextId);
    if (snapshot.groups.length === 0) {
      showMessage("没有可用分组", 5000, "error");
      return;
    }

    const groupOptions = snapshot.groups
      .map((group) => (
        `<option value="${escapeHtml(group.id)}">`
        + `${escapeHtml(group.name)}`
        + `${group.unlocked ? " · 本文档已解锁" : " · 本文档已锁定"}`
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
            解锁只作用于当前 Protyle；不会连带解锁秘密库或其他文档。口令不会持久化。
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
      const group = this.vault
        .getSnapshot(contextId)
        .groups
        .find((item) => item.id === groupSelect.value);

      if (!group) {
        setInlineError(error, "分组不存在");
        return;
      }

      const label = labelInput.value.trim();
      if (!label) {
        setInlineError(error, "label 不能为空");
        labelInput.focus();
        return;
      }

      ok.disabled = true;
      setInlineError(error, "");

      try {
        if (!this.vault.isGroupUnlocked(contextId, group.id)) {
          const unlocked = await this.requestUnlock(contextId, group.id);
          if (!unlocked) return;
        }

        const secretId = await this.vault.createSecret(
          contextId,
          group.id,
          label,
          contentInput.value,
        );
        const secret = this.vault.getSecret(secretId);
        if (!secret) throw new Error("秘密创建成功，但无法重新读取其元数据");
        const currentGroup = this.vault.getGroup(secret.groupId);
        if (!currentGroup) throw new Error("秘密创建成功，但所属分组无法重新读取");

        await this.references.insertFromSlash(secret, currentGroup.name, slashTarget);
        dialog.destroy();
      } catch (errorValue) {
        setInlineError(error, errorMessage(errorValue));
      } finally {
        ok.disabled = false;
      }
    };

    ok.addEventListener("click", () => void submit());
    cancel.addEventListener("click", () => dialog.destroy());

    const submitOnShortcut = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        void submit();
      }
    };
    labelInput.addEventListener("keydown", submitOnShortcut);
    contentInput.addEventListener("keydown", submitOnShortcut);

    setTimeout(() => labelInput.focus(), 0);
  }

  private openUnlockDialog(
    contextId: AccessContextId,
    groupId: GroupId,
    groupName: string,
    initialized: boolean,
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
              <span>${initialized
                ? "输入该分组口令；本次授权只作用于当前文档编辑器"
                : "该分组尚未设置口令；本次输入将成为其口令"}</span>
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
        if (!input.value) {
          error.textContent = "口令不能为空";
          return;
        }

        ok.disabled = true;
        error.textContent = "";

        try {
          await this.vault.unlockGroup(contextId, groupId, input.value);
          input.value = "";
          finish(true);
          dialog.destroy();
        } catch (unlockError) {
          input.value = "";
          input.focus();
          error.textContent = errorMessage(unlockError);
        } finally {
          ok.disabled = false;
        }
      };

      ok.addEventListener("click", () => void submit());
      cancel.addEventListener("click", () => dialog.destroy());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void submit();
      });

      setTimeout(() => input.focus(), 0);
    });
  }
}

function setInlineError(element: HTMLElement, message: string): void {
  element.textContent = message;
  element.classList.toggle("fn__none", !message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
