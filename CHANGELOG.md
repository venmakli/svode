# Changelog

## [Unreleased]

### Changed

- Removed the legacy configurable collection document tab. Collection `README.md` is now exposed only through the stable scope-level Readme surface; legacy `schema.yaml` `document` data is ignored until the next explicit schema write removes it. MCP `documentLabel` is no longer accepted.

### Fixed

- Fixed Windows VS Code project opener discovery for User/System installs, `code.cmd` PATH installs, hidden spawn, and actionable error details.

## [0.0.6] - 2026-06-24

### Added

- Dogfood update notification feed for published releases and manual installer builds.
- Integrated sidebar shell with root project scope, child space scope homes, scoped actions, space reorder support, and lazy tree loading.
- Public MCP `delete_entry` and `list_actors` tools, with tighter tool schemas and guidance.
- Editor Markdown I/O boundary with fixtures for GFM tables, task lists, links, images, code blocks, frontmatter, inline HTML, and conflict handling.

### Changed

- Ships the Stage 6 dogfood snapshot focused on frontend boundaries, entry metadata, Git status, MCP surface, sidebar shell, space tree performance, and editor Markdown I/O.
- Completed the Stage 6 frontend architecture pass: `shared`, `platform`, `app`, and feature ownership boundaries are enforced by lint rules.
- Refactored feature public APIs and ownership across space, git, search, identity, home, properties, entry, editor, terminal, settings, updates, and collection surfaces.
- Switched entry runtime identity to space/path and stopped materializing internal `id`, `created`, and `updated` frontmatter fields for new documents.
- Derived entry dates from indexed filesystem/Git data instead of persisted system frontmatter fields.
- Unified entry field saves for title, icon, description, cover, and custom properties with optimistic updates and race protection.
- Reworked Git status and commit policy around a single Git-backed dirty marker and explicit manual commit flows by default.
- Optimized space tree loading, watcher updates, and index refreshes around direct children, targeted updates, and heavy subtree ignore policy.
- Reworked collection view runtime ownership for table, board, calendar, list, gallery, query controls, templates, view settings, and entry peek flows.

### Fixed

- Suppressed unintended Windows background console windows from sidecars and background commands.
- Normalized Windows verbatim paths before exposing them to user-facing app, terminal, Git, MCP, and file URL flows.
- Fixed packaged MCP client discovery in installer builds.
- Fixed Markdown `<br>` deserialization and programmatic editor loads that could mark documents dirty.
- Fixed sidebar navigation sync for programmatic document opens, breadcrumbs, search results, Inbox, and Sessions surfaces.
- Fixed markdown link rewrite and backlink source rebase behavior for path changes.
- Fixed field-save races that could lose frontmatter updates under concurrent metadata edits.

### Compatibility

- Auto-update remains disabled for dogfood snapshots; release artifacts should not include `latest.json` or updater signatures.
- Existing YAML keys named `id`, `created`, and `updated` are preserved as custom frontmatter fields. Runtime identity is now path-based, and `created` / `updated` view/query fields refer to derived system dates.
- Git auto-commit for structural and system changes defaults to off. Users can commit explicit changes manually or enable the new per-space settings.
- Large nested repositories and ignored folders such as dependency/build caches are no longer eagerly scanned as normal content tree nodes.

## [0.0.5] - 2026-06-05

### Added

- First installable Svode dogfood snapshot.
- GitHub Actions release workflow for draft prerelease installers on macOS, Windows, and Linux.
- GitHub Actions check workflow for TypeScript, Rust, Clippy, and Rust dependency audit.
- Bundled `svode-mcp` and `lfs-dal` sidecars for installer artifacts.

### Changed

- Synchronized the desktop app, Tauri package, and `svode-mcp` release version on `0.0.5`.
- Established `CHANGELOG.md` as the source of truth for GitHub Release notes.
- Kept Stage 5 on `0.0.x` dogfood snapshots; `0.1.0` remains deferred until the first internal baseline after manual dogfood.

[Unreleased]: https://github.com/venmakli/svode/compare/v0.0.6...HEAD
[0.0.6]: https://github.com/venmakli/svode/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/venmakli/svode/releases/tag/v0.0.5
