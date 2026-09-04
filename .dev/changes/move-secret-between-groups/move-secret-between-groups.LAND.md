# LAND: 移动秘密到其他分组 + 点击引用按需刷新快照

> 变更工作区：`.dev/changes/move-secret-between-groups/`；配套文档：`move-secret-between-groups.DEV-SPEC.md`。

## 叙述

现有架构中，秘密的加密由分组密钥完成（AAD 绑定分组+秘密 ID），文档引用只携带非敏感快照且以 `custom-secret-id` 为权威身份。本次改动沿三个既有边界展开，不引入新模块、新依赖：

1. **数据层**：`VaultController` 新增一个「批量移动」持久化 mutation——内存中逐条用源组密钥解密、目标组密钥重加密，再一次性原子提交（沿用 clone → crypto → saveData → commit 单写者管线）。密钥获取继续只发生在 `VaultController` 内部；UI 只通过 `unlockGroup` 完成口令授权，绝不接触密钥。
2. **交互层**：点击引用的弹框打开路径中，把「身份校验」与「快照比对」合并到一次 `getBlockAttrs` 上（零额外请求）；发现快照陈旧时**先开弹框、后异步刷新**（弹框内容来自实时数据，不依赖块快照），成功仅 `showMessage`。
3. **UI 层**：工作台秘密列表增加多选行、操作条与「移动到…」对话框；对话框负责按锁定状态就地解锁源/目标组后调用移动。

跨模块规则：
- 快照格式知识（哪些属性是快照、如何比对、如何重建）只属于 `SecretReferenceService`；交互层只调用「是否需要刷新」与「刷新」。
- 移动的加解密只发生在 `VaultController`；`moveSecrets` 不做隐式解锁（缺授权直接抛错，沿用 `getAuthorizedKey` 语义）。
- 多选与对话框状态是 `VaultApp.svelte` 局部 UI 状态，不进 `VaultController`。

## 文件树

```text
src/types.ts                                    modify  (+1/-0)
  新增撤销原因 "secret-moved"（AuthorizationRevocationReason）。

src/vault.ts                                    modify  (+45/-0)
  VaultController.moveSecrets(contextId, secretIds, targetGroupId): Promise<number>
  批量移动 mutation：目标组校验 → 逐条解密（源组密钥）→ 全部解密成功后
  用目标组密钥重加密 → persistAndCommit 一次 → publishSnapshots +
  逐条 revoke scope:"secret"。~45 行，与 changeGroupPassword 同型。

src/reference/secret-reference.ts               modify  (+25/-8)
  - 新增 loadReference(blockId, expectedSecretId): Promise<{attrs} | null>：
    一次 getBlockAttrs 完成身份校验并返回 attrs（openFromAnchor 复用，零额外请求）。
  - 新增 snapshotNeedsRefresh(attrs, secret, groupName): boolean：
    纯内存比较快照字段（label/groupId/groupName/created/updated）。
  - refreshSnapshot 保持不变（内部仍用 matchesReference 做写前身份校验）。

src/interaction/secret-interaction.ts           modify  (+18/-12)
  openFromAnchor 调整：
  - matchesReference(...) → loadReference(...)（拿到 attrs，校验语义不变）；
  - getSecret/getGroup 后先 getSecretView + openPopover（立即响应）；
  - 若 snapshotNeedsRefresh → 异步 refreshSnapshot + showMessage；失败仅非阻断警告。
  ~30 行净改动，职责不变（仍是唯一弹框生命周期所有者）。

src/ui/VaultApp.svelte                          modify  (+180/-20)
  - 列表行 hover 时右端淡入「⇄」快捷按钮（绝对定位覆盖 chevron，零布局影响），
    点击直接打开单条移动对话框；
  - 头部「多选」进入显式多选模式：checkbox 才显示（平时不占位），
    操作条（已选 N 项 / 移动到… / 取消），行点击切换勾选；
  - 「移动到…」modal（与现有 showPasswordDialog 同模式）：目标分组单选
    （排除当前组）、源/目标口令按锁定状态显示、错误提示、确认；
  - 确认流程：unlockGroup(源) → unlockGroup(目标) → moveSecrets →
    showMessage 成功消息、退出多选、刷新列表（视图停留原分组）；
  - 详情面板工具条新增「移动到…」（单条，复用同一 modal）。
  约 +180 行，集中在列表/对话框两段，不重排现有结构。

无新文件、无新依赖、无 schema 变更（VaultData 结构不变）。
```

## 幅度与影响

- `src/vault.ts` / `secret-reference.ts` / `secret-interaction.ts` 均为局部增量（各 ≤50 行），现有逻辑几乎全部保留。
- `VaultApp.svelte`（773 行）改动约 +170 行，占现有 UI 的 ~22%，但只涉及列表与对话框两个区域，不重组布局；保留既有 inline-card / modal 模式。
- 不触及迁移中心、文档插入、弹框加密展示逻辑。

## 待确认（默认值，可重定向）

1. 移动成功后视图**停留原分组**（SPEC 默认）；如需自动跳转目标组，仅改 UI 收尾一段。
2. 批量移动**整批原子**（任一条失败全部回滚）；如需部分成功报告，需改动 `moveSecrets` 语义与对话框结果展示。
3. 快照刷新失败：异步 catch 后**静默或非阻断警告**（默认静默 + 控制台日志；警告文案待 UI 评审）。
