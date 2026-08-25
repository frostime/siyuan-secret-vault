# SiYuan Secret Vault

一个以 `siyuan-note/plugin-sample-vite-svelte` 的 `svelte5` 分支为结构与 API 基线的思源插件原型，用于管理分组秘密并把交互式秘密引用插入文档。

## 当前设计

- 每个 group 使用独立的用户口令。
- **口令从不持久化**；解锁后只在内存中保留不可导出的 `CryptoKey`。
- `label` 为明文元数据；只有 `content` 使用 AES-256-GCM 加密。
- 口令通过 PBKDF2-SHA-256 派生 AES key；每组保存独立随机 salt、迭代参数和认证 verifier。
- 插件数据保存在 `vault.json`（由思源 `Plugin.saveData/loadData` 管理）。
- 文档引用使用原生 IFrame Block，指向 `/plugins/siyuan-secret-vault/embed/index.html?secret=...`。
- embed 页只负责 UI，通过 `postMessage` 与主插件 broker 通信；不轮询、不扫描 Protyle DOM、不使用 MutationObserver。
- 插入时额外尝试写入 IAL：`custom-secret-id`、`custom-secret-group`，用于后续 SQL 索引。实际引用主键仍以 iframe URL 中的 `secret` 为准。

## MVP 已实现

- default 分组（首次解锁时设置口令）
- 新建/删除分组
- 分组解锁、锁定、修改口令
- 新建、编辑、删除秘密
- label 搜索
- 复制 content
- 将秘密作为 IFrame 引用插入最近活动文档
- IFrame 中显示 label / group / 锁定状态
- IFrame 中解锁并显示、复制、锁定分组、打开 Vault GUI
- 多端插件数据变化时重新加载并清空内存 key

## 安全边界

本插件目标是保护工作空间、同步介质和静态插件数据中的 `content`。它不试图抵抗已经控制 SiYuan renderer 的恶意插件/XSS；分组解锁后，主 renderer 中运行的恶意代码理论上仍有能力窃取明文。

`label` 明确设计为明文，请勿在 label 中写入本身需要保密的信息。

## 开发

需要 Node.js 和 pnpm/npm：

```bash
npm install
npm run dev
```

将生成的 `dev/` 目录链接或复制到工作空间：

```text
<workspace>/data/plugins/siyuan-secret-vault
```

生产构建：

```bash
npm run build
```

会生成 `dist/` 和 `package.zip`。

## 本版本验证状态

已完成：

- TypeScript strict 静态检查。
- 使用本地 Svelte 5.48 编译器对 `VaultApp.svelte` 进行编译检查，无 warning。
- PBKDF2 + AES-GCM 加解密 round-trip。
- Vault 生命周期测试：default 首次设口令、错误口令拒绝、创建/读取秘密、锁定、修改口令、不同 group 独立口令、重新初始化后 key 不残留。
- embed JavaScript 语法检查。

当前执行环境无法拉取 npm 依赖，因此没有在这里完成完整 `npm install && npm run build`。源码依赖版本按上游 Svelte 5 模板配置；请在实际开发机上安装依赖后构建。

## 需要在真实 SiYuan 3.8.0 中重点验证

1. `protyle.insert(<iframe> + IAL)` 是否稳定生成 `NodeIFrame`，以及 IAL 是否落在该 iframe block 上。
2. IFrame Block 在复制、移动、撤销/重做、导出以及移动端/浏览器前端的行为。
3. `switch-protyle` / `loaded-protyle-static` 在多窗口场景下对“最近活动文档”的选择是否符合预期。
4. 大量 IFrame 引用时的 renderer 资源占用。

本版本刻意不通过 DOM 扫描来修复上述问题；如果 IAL 不稳定，应改为在插入 API 返回 block ID 后调用 `setBlockAttrs`，而不是监听和改写 Protyle DOM。

## v0.1.1 交互入口

- 顶栏按钮打开 Vault 自定义页签。
- 编辑器输入 `/secret`、`/秘密`、`/插入秘密` 等可打开 Secret 选择器，并在当前编辑器位置插入 IFrame 引用。
- Custom Tab ID 严格使用 `plugin.name + TAB_TYPE`，与 SiYuan `addTab/openTab` 约定保持一致。

## 0.1.2 插入修复

- Slash 命令不再使用 `protyle.insert(iframe + IAL)`；该调用受当前光标/内联解析上下文影响，会把块 IAL 当作普通段落文本。
- Slash 回调会立即用 `Lute.Carte` 消费 `/secret` 查询文本，然后通过 `/api/block/insertBlock` 插入独立 `<iframe>`，并检查返回 DOM 必须为 `NodeIFrame`。
- 新块 ID 返回后再单独调用 `/api/attr/setBlockAttrs` 写入 `custom-secret-*` 索引属性，避免 IAL 与 iframe 一起解析。
- 新增“新建秘密并插入” Slash 命令；可直接在文档中选择分组、填写明文 label 和待加密 content。若分组锁定，会在保存时请求该分组口令。
- “插入已有秘密”选择器顶部也提供“+ 新建秘密并插入”。
