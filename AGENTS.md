# AGENTS.md

SiYuan 插件：加密秘密库。秘密按分组组织，每组独立口令（PBKDF2 + AES-256-GCM），明文只存在于内存；文档中是惰性 v4 引用段落（无运行时），点击后才弹出插件自有的非模态悬浮框。

## 常用命令

- `pnpm dev` — 开发模式（vite watch build）
- `pnpm build` — 生产构建，产物在 `dist/`；`package.zip` 由 CI 在打 tag 时生成
- `pnpm check` — svelte-check 类型检查。**存在既有基线错误**（siyuan 类型声明过旧：`Protyle.wysiwyg`/`block`/`replaceAll` 等，当前 15 errors / 4 warnings）：改动前后对比该计数，不引入新增错误即可

无自动化测试框架。验证方式 = check 计数不变 + build 通过 + 在思源中加载 `dist/` 手工验证。

## 关键模块（src/）

- `vault.ts` — VaultController：VaultData 持久化与全部加密 mutation（clone → crypto → saveData → commit，单写者队列）
- `access.ts` — GroupAccessManager：CryptoKey 生命周期、上下文级授权、15 分钟空闲锁定
- `crypto.ts` — PBKDF2 / AES-256-GCM 原语；AAD 绑定 `group:<groupId>:secret:<secretId>`
- `reference/secret-reference.ts` — v4 引用段落格式（URL + `custom-secret-*` 属性）；`custom-secret-id` 是唯一权威身份
- `interaction/secret-interaction.ts` — 点击引用 → 弹框生命周期；打开前校验引用身份，陈旧快照后台刷新
- `ui/VaultApp.svelte` — 工作台：分组/秘密管理、多选移动、迁移中心
- `migrations/reference-to-paragraph.ts` — v1/v2/v3 → v4 显式迁移任务
- `siyuan/api.ts` — 内核 HTTP 边界（块/属性/SQL）

## 架构边界（必须遵守）

- 文档引用无运行时：不开 iframe/widget/脚本/轮询；打开文档不执行插件代码
- 不直接编辑 `.sy` 文件，不使用 fs / Electron API（会破坏同步分块）；持久写走内核 API 或 `Plugin.saveData`
- 启动不扫描、不改写用户文档；扫描与迁移必须用户显式触发
- 口令不落盘；密钥仅内存；明文只在授权上下文展示
- 引用快照（label/分组名/时间戳）是非权威展示数据，可能陈旧；刷新只在显式交互时进行
- 任何持久 mutation 都必须走 `VaultMutationCoordinator`（单写者）

## 文档与约定

- 架构文档：`.dev/docs/architecture.md`
- 变更工作区：`.dev/changes/<slug>/`（SPEC/LAND/原型）；完成后把持久知识迁回代码/文档并删除该目录
- CHANGELOG 遵循 Keep a Changelog；提交信息遵循 Conventional Commits + emoji 前缀（见 `.pi` 的 git-commit-msg skill）
