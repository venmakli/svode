# Changelog

## [Unreleased]

## [0.0.6] - 2026-06-03

### Added

- Первый installable dogfood snapshot для Svode.
- GitHub Actions release workflow для draft/prerelease installers на macOS, Windows и Linux.
- GitHub Actions check workflow для TypeScript, Rust, Clippy и Rust dependency audit.
- Единый release process через `CHANGELOG.md`, app version sources и GitHub Release body.
- Bundled `svode-mcp` и `lfs-dal` sidecars для installer artifacts.

### Changed

- Версия desktop app, Tauri package и `svode-mcp` синхронизирована на `0.0.6`.
- Stage 5 остаётся на `0.0.x` dogfood snapshots; `0.1.0` отложен до первого внутреннего baseline после ручного dogfood.

[Unreleased]: https://github.com/venmakli/svode/compare/v0.0.6...HEAD
[0.0.6]: https://github.com/venmakli/svode/releases/tag/v0.0.6
