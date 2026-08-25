<script lang="ts">
  import { onMount } from "svelte";
  import { showMessage } from "siyuan";
  import type { VaultController } from "../vault";
  import type { VaultSnapshot } from "../types";

  let { controller } = $props<{ controller: VaultController }>();
  let snapshot = $state<VaultSnapshot>({
    revision: 0,
    groups: [],
    secrets: [],
    focusedSecretId: null,
  });
  let selectedGroupId = $state("default");
  let filter = $state("");
  let modal = $state<"none" | "group" | "unlock" | "secret" | "edit" | "password">("none");
  let busy = $state(false);
  let formName = $state("");
  let formPassword = $state("");
  let formLabel = $state("");
  let formContent = $state("");
  let editingSecretId = $state<string | null>(null);
  let errorText = $state("");

  const selectedGroup = $derived(snapshot.groups.find((g) => g.id === selectedGroupId) ?? snapshot.groups[0]);
  const filteredSecrets = $derived(snapshot.secrets.filter((secret) => {
    if (secret.groupId !== selectedGroup?.id) return false;
    const q = filter.trim().toLowerCase();
    return !q || secret.label.toLowerCase().includes(q);
  }));

  onMount(() => controller.subscribe((next) => {
    snapshot = next;
    if (!snapshot.groups.some((group) => group.id === selectedGroupId)) {
      selectedGroupId = snapshot.groups[0]?.id ?? "default";
    }
    if (snapshot.focusedSecretId) {
      const secret = snapshot.secrets.find((item) => item.id === snapshot.focusedSecretId);
      if (secret) selectedGroupId = secret.groupId;
    }
  }));

  function closeModal() {
    resetForm();
    modal = "none";
  }

  function resetForm() {
    formName = "";
    formPassword = "";
    formLabel = "";
    formContent = "";
    editingSecretId = null;
    errorText = "";
  }

  async function run(action: () => Promise<void>) {
    busy = true;
    errorText = "";
    try {
      await action();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  function openGroupModal() {
    resetForm();
    modal = "group";
  }

  function openUnlockModal() {
    resetForm();
    modal = "unlock";
  }

  function openNewSecret() {
    resetForm();
    modal = "secret";
  }

  async function openEdit(secretId: string) {
    resetForm();
    const secret = snapshot.secrets.find((item) => item.id === secretId);
    if (!secret) return;
    editingSecretId = secret.id;
    formLabel = secret.label;
    await run(async () => {
      formContent = await controller.readSecret(secret.id);
      modal = "edit";
    });
  }

  async function deleteSecret(secretId: string) {
    if (!confirm("确定删除这个秘密？文档中的引用将变成失效引用。")) return;
    await run(async () => controller.deleteSecret(secretId));
  }

  async function deleteGroup() {
    if (!selectedGroup || selectedGroup.id === "default") return;
    if (!confirm(`确定删除分组“${selectedGroup.name}”？`)) return;
    await run(async () => controller.deleteGroup(selectedGroup.id));
  }
</script>

<div class="vault-shell">
  <aside class="vault-sidebar">
    <div class="vault-brand">🔐 Secret Vault</div>
    <button class="b3-button b3-button--outline vault-new-group" onclick={openGroupModal}>+ 新建分组</button>
    <div class="vault-group-list">
      {#each snapshot.groups as group}
        <button
          class:active={group.id === selectedGroupId}
          class="vault-group"
          onclick={() => selectedGroupId = group.id}
        >
          <span>{group.name}</span>
          <small>{group.secretCount} · {group.unlocked ? "已解锁" : group.initialized ? "已锁定" : "未设口令"}</small>
        </button>
      {/each}
    </div>
  </aside>

  <main class="vault-main">
    {#if selectedGroup}
      <header class="vault-header">
        <div>
          <h2>{selectedGroup.name}</h2>
          <div class="vault-muted">{selectedGroup.unlocked ? "当前解锁密钥仅保存在内存；15 分钟无访问自动锁定" : "content 保持加密，label 为明文元数据"}</div>
        </div>
        <div class="vault-actions">
          {#if selectedGroup.unlocked}
            <button class="b3-button b3-button--outline" onclick={() => controller.lockGroup(selectedGroup.id)}>锁定</button>
            <button class="b3-button b3-button--outline" onclick={() => { resetForm(); modal = "password"; }}>修改口令</button>
          {:else}
            <button class="b3-button b3-button--outline" onclick={openUnlockModal}>{selectedGroup.initialized ? "解锁" : "设置口令"}</button>
          {/if}
          {#if selectedGroup.id !== "default"}
            <button class="b3-button b3-button--outline" onclick={deleteGroup}>删除分组</button>
          {/if}
        </div>
      </header>

      <div class="vault-toolbar">
        <input class="b3-text-field" bind:value={filter} placeholder="按 label 搜索" />
        <button class="b3-button b3-button--text" disabled={!selectedGroup.unlocked} onclick={openNewSecret}>+ 新建秘密</button>
      </div>

      {#if !selectedGroup.unlocked}
        <div class="vault-lock-note">
          <strong>{selectedGroup.name}</strong> 当前未解锁。label 仍可浏览；查看、复制、编辑 content 需要输入该分组自己的口令。
        </div>
      {/if}

      <div class="vault-list">
        {#each filteredSecrets as secret}
          <article class="vault-secret" class:focused={snapshot.focusedSecretId === secret.id}>
            <div class="vault-secret-title">
              <strong>{secret.label}</strong>
              <code>{secret.id}</code>
            </div>
            <div class="vault-secret-actions">
              <button class="b3-button b3-button--outline" onclick={() => run(async () => controller.insertSecret(secret.id))}>插入文档</button>
              <button class="b3-button b3-button--outline" disabled={!selectedGroup.unlocked} onclick={() => run(async () => {
                await navigator.clipboard.writeText(await controller.readSecret(secret.id));
                showMessage(`已复制：${secret.label}`);
              })}>复制</button>
              <button class="b3-button b3-button--outline" disabled={!selectedGroup.unlocked} onclick={() => openEdit(secret.id)}>编辑</button>
              <button class="b3-button b3-button--outline" disabled={!selectedGroup.unlocked} onclick={() => deleteSecret(secret.id)}>删除</button>
            </div>
          </article>
        {:else}
          <div class="vault-empty">这个分组还没有秘密。</div>
        {/each}
      </div>
    {/if}

    {#if errorText}
      <div class="vault-error">{errorText}</div>
    {/if}
  </main>
</div>

{#if modal !== "none"}
  <div class="vault-modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) closeModal(); }}>
    <section class="vault-modal" role="dialog" aria-modal="true">
      {#if modal === "group"}
        <h3>新建分组</h3>
        <label>分组名称<input class="b3-text-field" bind:value={formName} /></label>
        <label>该分组的口令<input class="b3-text-field" type="password" autocomplete="new-password" bind:value={formPassword} /></label>
        <p class="vault-muted">口令不会保存。只保存随机 salt、KDF 参数和用于验证口令的认证密文。</p>
      {:else if modal === "unlock"}
        <h3>{selectedGroup?.initialized ? `解锁 ${selectedGroup?.name}` : `为 ${selectedGroup?.name} 设置口令`}</h3>
        <label>口令<input class="b3-text-field" type="password" autocomplete="current-password" bind:value={formPassword} /></label>
      {:else if modal === "secret" || modal === "edit"}
        <h3>{modal === "secret" ? "新建秘密" : "编辑秘密"}</h3>
        <label>Label（明文）<input class="b3-text-field" bind:value={formLabel} /></label>
        <label>Content（加密）<textarea class="b3-text-field vault-textarea" bind:value={formContent}></textarea></label>
      {:else if modal === "password"}
        <h3>修改 {selectedGroup?.name} 的口令</h3>
        <label>新口令<input class="b3-text-field" type="password" autocomplete="new-password" bind:value={formPassword} /></label>
        <p class="vault-muted">会在内存中解密该组所有 content，再用新口令派生的密钥重新加密；原口令仍不会落盘。</p>
      {/if}

      {#if errorText}<div class="vault-error">{errorText}</div>{/if}
      <footer>
        <button class="b3-button b3-button--cancel" disabled={busy} onclick={closeModal}>取消</button>
        <button class="b3-button b3-button--text" disabled={busy} onclick={() => run(async () => {
          if (modal === "group") {
            const newGroupId = await controller.createGroup(formName, formPassword);
            selectedGroupId = newGroupId;
          } else if (modal === "unlock") {
            await controller.unlockGroup(selectedGroup!.id, formPassword);
          } else if (modal === "secret") {
            await controller.createSecret(selectedGroup!.id, formLabel, formContent);
          } else if (modal === "edit" && editingSecretId) {
            await controller.updateSecret(editingSecretId, formLabel, formContent);
          } else if (modal === "password") {
            await controller.changeGroupPassword(selectedGroup!.id, formPassword);
          }
          closeModal();
        })}>确定</button>
      </footer>
    </section>
  </div>
{/if}
