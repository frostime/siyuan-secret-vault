# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
