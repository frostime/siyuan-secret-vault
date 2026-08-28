# Secret Vault 0.6.0

0.6.0 将文档内 Secret 引用彻底改为 **普通段落块 + 插件链接**。

- 文档打开时没有 IFrame / Widget runtime；
- 没有每个引用自己的脚本、消息通道、轮询、observer 或自动刷新；
- Secret 明文仍只由 Vault 解密，按 Protyle context 授权；
- 用户显式点击段落中的插件链接后，才在 `document.body` 上打开一个非模态悬浮交互框；
- 悬浮框支持解锁、查看多行内容、原地编辑、复制和锁定分组；
- Vault 同步 reload、context 销毁、锁定、idle timeout 或插件卸载都会收回授权并关闭明文交互；
- 旧 v1/v2 IFrame 和 v3 Widget 不会在启动时自动改写，请在 **秘密库 → 数据与迁移** 中显式迁移到 v4。

建议迁移前先完成思源同步并关闭包含旧 Secret 引用的文档。
