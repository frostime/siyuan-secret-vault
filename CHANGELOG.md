# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 秘密列表支持勾选多条并移动到另一个分组：列表多选操作条与详情面板均提供「移动到…」入口，源/目标分组锁定时可就地输入口令完成移动。
- 点击文档中的秘密引用时，插件会校验引用快照与最新数据（label、分组名），陈旧快照在后台刷新并通过提示条告知，不阻塞弹框打开。

### Changed

- 移动的秘密改用目标分组密钥重新加密；秘密 ID 与创建时间保持不变，文档引用在移动后继续有效，分组口令保持各自独立。

### Fixed

- 修复新增分组卡片中口令/名称输入框宽度溢出窄列的问题。

## [0.2.0] - 2026-08-26

### Added

- Added independent access contexts for the built-in vault and each live Protyle editor.
- Added dedicated modules for access lifetime, editor integration, embed messaging, and serialized vault mutations.

### Changed

- Unlocking a group now grants access only to the initiating vault or Protyle context; it no longer unlocks other documents.
- Closing a Protyle immediately retires its access context, and each context/group grant has its own 15-minute inactivity timeout.
- Changing a group password now revokes grants established with the previous password while keeping the initiating context unlocked when it remains active.
- Embed invalidation is scoped by secret, group, or Protyle context, and iframe resizing remains interaction-driven and session-local.

### Fixed

- Serialized complete vault mutation lifecycles so password rotation cannot interleave with writes encrypted by an obsolete key.
- Prevented competing contexts from initializing the same group with different passwords.
- Persisted detached staged snapshots before publishing in-memory state, preventing failed saves from leaking into later queued snapshots.
- Prevented delayed unlock operations from restoring access to a Protyle that has already closed.
- Revalidated picker selections before inserting a Secret reference that may have been deleted.
