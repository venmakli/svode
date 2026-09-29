# Changelog

## [0.0.9] - 2026-09-29

### Added

- **Svode CLI.** Added the `svode` command covering the MCP data scope: Page, owner, and item reads and writes, Collection schema, views, and integrity checks, structural changes, asset import, App manifest validation, Search and Knowledge, Git status and repository access verification, and Routine definitions. Commands resolve the Project and Space from the working directory, print `--json` output, and return stable error codes and exit statuses.
- **Headless runtime.** `svode-mcp --project <path>` and `svode` serve a project without the desktop app: index-backed reads, Git status, repository access, all data writes, and Routine definitions. The headless catalog has 53 tools; `run_routine` stays available only through the running desktop app.
- **Automatic MCP mode.** `svode-mcp` without arguments uses the desktop bridge when the app answers at session start, and otherwise serves the project of the launch directory headless.
- **Svode plugin and agent connections.** Added the Svode plugin payload, a CLI-first product skill for Claude Code and Codex, and a stable runtime location `~/.svode` with `svode` and `svode-mcp` launchers. Settings → Providers connects Claude Code and Codex with one switch (skill, `svode`, and MCP) and shows CLI detection, sign-in, versions, and Doctor; `svode integration` does the same without the desktop app. Connections update together with the runtime.
- **Standalone runtime.** Added a standalone runtime archive and installer script for macOS and Linux x86_64 that installs `svode` and `svode-mcp` without the desktop app and coexists with a desktop installation. Public download channels come later.
- **Coordinated source writes.** Desktop, MCP, and CLI writers guard managed source writes per repository. Body writes carry the `sourceVersion` of the last read and fail with `SOURCE_STALE` or `SOURCE_BUSY` instead of overwriting another writer's change; the desktop editor keeps a stale draft and offers inline recovery.
- **External open.** A shared split button opens projects, Pages, documents, and media in the OS default app or another installed app, with real app names and icons on macOS, Windows, and Linux.
- **Terminal drawer.** The terminal opens in a resizable drawer on the right or at the bottom, toggled from Sessions or with Ctrl+`.
- **Settings.** Application and project settings share one dialog with a compact user menu, theme controls, update checks, and a keyboard shortcut reference. Settings pages are laid out as titled groups of rows per Project, Space, and repository.
- **Scoped Variables.** Project, Space, and global Variables with shared secrets for Apps, S3 storage, and LFS credentials, saved through the guarded system autocommit.

### Changed

- Ships the accepted and frozen Stage 9 snapshot. Page, Collection, structural, import, index, Search and Knowledge, Git, and Routine logic moved into the `svode-core` library; the desktop app, MCP, and CLI run the same domain operations with the same validation, effects, and rollback.
- `svode-mcp` is a standalone package over the shared `svode-tools` tool surface instead of a service embedded in the desktop app.
- Renamed the LFS sidecar from `lfs-dal` to `svode-lfs`; existing LFS registrations are repaired automatically.
- The full Page and Peek use one Page detail runtime, and Page, Space, Collection, and App tabs come from one shared scope surface in both views.
- Merged repository access into the header Git sync control; Changes shows as a quiet icon when its scope has nothing to review.
- Routine executors are shown as agent actors with an avatar and name.
- Human avatars use local initials; Gravatar lookups are removed.
- Upgraded Plate to 53, keeping links inside Markdown tables.
- Git operations are coordinated per repository and intent, with faster local observation and publication checks.

### Fixed

- Fixed Git saves of new files with non-ASCII paths, saves after a chain of renames, project root saves with submodule Spaces, submodule Spaces left in detached HEAD after cloning, and LFS downloads in submodules and worktrees.
- `lfs-s3` Spaces declare their object storage in a committed `.lfsconfig`, and LFS push rejections show typed, localized recovery instead of raw Git output.
- Repository access status follows the actual ability to write, is verified once on activation and expiry, and is shared across processes; access-probe commits no longer appear as actors.
- Page rename is isolated from unrelated broken Collection schemas. Blocked saves name every blocking repository and let you discard unsaved changes, and unsaved property drafts stay visible.
- An open Page detail picks up another writer's metadata and schema changes, and only the surface whose file disappeared closes.
- Select and multi-select columns can be created without options; row action menus open from the keyboard and VoiceOver; attachments include nested Collections and App owners.
- Failed App processes are no longer treated as external services. App processes and agent CLI detection use the login shell `PATH` when the app is launched from Finder.
- Fixed sidebar expansion after renames and moves, the dark theme startup background, CRLF frontmatter boundaries on Windows, accumulating incompatible local database copies, local ignore rules for Spaces, and Variables load errors without a cause.

### Migration

- On first start the desktop app installs its runtime into `~/.svode` and moves the Claude Code and Codex MCP entries that earlier desktop versions managed to the `~/.svode/bin/svode-mcp` launcher. Settings → Providers replaces MCP Integrations and CLI Agents. Restart open agent sessions to pick up the change.
- The `create_collection_item` MCP tool is removed. Create Collection items with `create_page` in the Collection directory; its schema applies by location and initial properties are validated against it.
- `write_page`, `update_collection_item_body`, `write_space_readme`, and `write_collection_readme` require the `sourceVersion` returned by the last read or write of that source.

### Compatibility

- Select and multi-select columns may now have no options, and `schema.yaml` stores them as `options: []`. Svode and `svode-mcp` builds up to 0.0.8 reject such a Collection schema with a schema error; update every client that opens the same Space.
- Headless MCP and the CLI do not launch Routines; one-time Routine launches without the desktop app are planned for a later release.
- The standalone runtime and installer target macOS and Linux x86_64; Windows support comes later.
- Auto-update, Apple notarization, and platform code signing remain disabled for dogfood snapshots; installers are distributed through draft prereleases without `latest.json` or updater signatures.

## [0.0.8] - 2026-09-06

### Added

- **Artifact surfaces.** Added a shared resolver and opening flow for Markdown Pages, Documents, and Media across full-page and Peek surfaces, preserving Project, Space, Collection, Routine, and Agent Context ownership.
- **Repository work mode.** Added one repository-derived work status and shared access recovery for managed writes across Pages, Collections, Actors, Routines, and attachments.
- **Attachments.** Added owner-scoped attachment tables for Projects, Spaces, and directory-backed Pages, with colocated Desktop, editor, and MCP imports, first-import Page conversion, and portable Git/LFS storage routing.
- **Document previews.** Added read-only PDF, DOCX, XLSX, and PPTX viewers with format-local navigation and find, bounded loading, local renderer assets, and external-open recovery.
- **Media viewers.** Added PNG, JPEG, WebP, GIF, and SVG previews with fit/zoom controls, plus native audio/video playback for formats supported by the current runtime.
- **Apps.** Added an App tab to existing directory owners through a direct `app.yaml`, supporting local static files, managed process setup/start, and external URLs. Added Settings Variables, OS Keychain-backed secrets, and MCP guidance and validation for agent-authored Apps.
- **Changes.** Added a right-side working-tree review drawer for Pages, Collections, Spaces, and Projects, with exact file or repository-subtree scope, text diffs, filters, totals, and a scope-matched save action that preserves unrelated staged changes.
- **Routines and Actors.** Added guided creation flows, stable Routine identity across renames, local-time and fixed-timezone schedules, and owner-aware Routine MCP reads, CRUD, and explicit dispatch.

### Changed

- Ships the accepted and frozen Stage 8 snapshot, with canonical Page naming and frontend ownership while keeping Markdown files as the portable source of truth.
- Converged schema-backed Page Collections and fixed Actors, Routines, Agent Context, and Attachments on one Collection presentation and interaction runtime.
- Separated Collection membership from sidebar and global discovery visibility: hidden schema members remain available in their explicit Collection without exposing their content through Search, Knowledge, or backlinks.
- Separated rebuildable indexes, Routine operational state, and local preferences into independent storage lifecycles; automatic Routine execution is controlled per owner.
- Made the MCP sidecar a build-neutral bridge that reads the active desktop's tool catalog and protocol responses.
- Standardized Yes/no properties on the `boolean` type with Checkbox or Switch display, and shared property settings across tables and Page property lists.

### Fixed

- Fixed language, appearance, Git identity, and MCP settings synchronization across windows, background-window responsiveness, and Settings reopen behavior.
- Fixed automatic refresh of Agent Context, Actors, and Routines, while preserving selection, query, and detail state.
- Improved Agent Context discovery, provenance, diagnostics, gallery layout, and complete Markdown detail rendering; corrected Search and Knowledge detail sizing.
- Fixed Unicode filenames, same-container name uniqueness, title/path save races, and Collection rename updates across indexes, backlinks, and open Page sessions.
- Fixed root-owner README Collection membership, first-click table activation, nested and full-page navigation, and consistent activation across all five Page Collection presentations.
- Fixed LFS format selection, scrolling, and storage-rule controls, plus Page view-mode title, property, and header geometry.
- Updated Document, Media, and App external opening to the supported Tauri Opener API and corrected release Clippy failures and the stale Routine MCP schema assertion.

### Migration

- Replace legacy `type: checkbox` columns in `schema.yaml` with `type: boolean`. Use optional `display: checkbox` or `display: switch`; existing boolean values need no conversion. The legacy type is rejected with an invalid-schema diagnostic.
- Routine definitions now require a unique portable lowercase ULID `id`; legacy definitions without one need source repair or recreation before execution. Replace legacy `title` with `name`; managed creation and editing require a non-empty name, while external definitions without a name can use the filename as their display label.
- Upgrading from the former mixed `index.db` storage resets local Routine pending events, checkpoints, run evidence, and automatic authority. Portable Routine definitions remain intact. Re-enable automatic execution for each intended owner after upgrading; old local runtime state is not imported, and downgrade continuity is unsupported.
- Existing index snapshots rebuild automatically. Existing `.assets` references keep working; new managed imports use the owning directory without a bulk file migration.
- Page MCP tools use canonical Page names; legacy document/entry tool aliases have been removed. Restart existing MCP client sessions to discover the current desktop catalog.

### Compatibility

- PDF and Office previews are read-only; global search across their contents is deferred. Preview fidelity and audio/video codec support depend on the format and runtime, with external-open fallback.
- App viewports do not receive internal Svode/Tauri APIs. Managed process recipes execute with the current OS user's permissions.
- Auto-update, Apple notarization, and platform code signing remain disabled for dogfood snapshots; installers are distributed through draft prereleases without `latest.json` or updater signatures.

## [0.0.7] - 2026-08-11

### Added

- **Scope Surfaces.** Added capability-driven Space and Collection tabs for Context, Description, Actors, Collection, and Routines, including stable defaults and compact/peek composition.
- **Agent Sessions.** Added a dedicated surface for project- and Space-scoped Codex and Claude Code sessions with evidence-based statuses, Now/Past grouping, pinning, and terminal-first re-entry.
- **System Collections.** Added a shared presentation layer for native system catalogs with Collection-style List/Gallery views, queries, actions, guarded creation, and one floating Detail Drawer.
- **Human Actors and repository access.** Added Scope-local contributor catalogs backed by `.mailmap`, activity profiles, repository write-capability verification, and guarded identity mutations.
- **Agent Context.** Added galleries for native Codex and Claude Code instructions and skills with owner, precedence, availability, discovery provenance, safe Markdown reading, and workspace-aware external openers.
- **Agent Actors.** Added portable Space-owned agent identities in `.svode/agent-actors.json` with ordered Codex/Claude bindings, typed model and effort selection, and device-local approval modes.
- **Routines.** Added `.routines/*.md` catalogs, typed `update_properties` and `run_agent` actions, manual execution, visible Session handoff, timezone-aware schedules, Collection events, local consent, and Git-backed cross-clone claims.
- **Knowledge Graph.** Added project/Space discovery across documents, Collection entries, instructions, and skills through Search, a compact graph, an unlisted full-page Graph, related-context reads, local cache repair, and read-only MCP tools.

### Changed

- Stage 7 is now the accepted and frozen dogfood snapshot; Scope Home retains its Stage 6 native README/content-navigation contract.
- Registered Spaces can also expose Collection capability without losing their Space identity; collection views now live under a stable Collection surface, while `README.md` remains the Description surface.
- System Collections use the existing Collection presentation core without introducing user schemas, generic backend DTOs, or a hidden universal Svode database.
- Search now unifies results, details, and graph discovery; Graph is a main surface without a persistent sidebar item.
- Agent context, routines, actor catalogs, and knowledge indexes use native or Git-backed artifacts with bounded local rebuildable caches instead of a Svode-owned agent harness.
- Removed the legacy configurable collection document tab. Collection `README.md` is exposed only through the stable scope-level Readme surface; legacy `schema.yaml` `document` data is ignored until the next explicit schema write removes it. MCP `documentLabel` is no longer accepted.

### Fixed

- Fixed Windows external-editor discovery, project window isolation, and recent-project behavior.
- Fixed Git LFS discovery from the desktop environment and corrected storage enrollment, inheritance, explicit Apply, remote diagnostics, S3 prefixes, sidebar status, and repository-wide media policy without rewriting history.
- Fixed Git status markers for new, nested, duplicate-named, and externally cleaned paths; clarified save shortcut scope and restored saves from Space Home and Collection surfaces.
- Fixed submodule scaffold commits, personal auto-commit/auto-sync policy, branch ahead/behind and Sync result reporting, plus actionable and fail-fast remote authentication.
- Fixed MCP root-Space and caller-project resolution, semantic tree/Space ordering, managed collection conversion and structural operations, integrity checks, and managed asset imports.
- Fixed custom Space folder naming and avoided traversing registered child Spaces from root Collection workloads.
- Fixed Collection Board scrolling, external schema/entry refresh stability, cross-Space and two-way relations, entry icon/title consistency, Table relation interactions, and compact peek layout parity.
- Fixed sidebar drag-and-drop ordering, Collection moves, watcher refresh, active-Space collapse, nested chevrons, Project Settings entry points, collapse-all behavior, resize persistence, and Git identity presentation.
- Updated S3 and plist dependency chains to remove the high-severity `quick-xml` denial-of-service vulnerabilities reported by RustSec.

### Compatibility

- Auto-update remains disabled for dogfood snapshots; release artifacts must not include `latest.json` or updater signatures.
- Stage 7 does not add a first-party agent harness, hidden background agent execution, or a durable workflow runtime. Native Codex and Claude Code artifacts remain the canonical agent-facing format.
- Knowledge indexing is local and rebuildable: `.svode/index.db` is not canonical project content and is excluded from Git.
- Existing collection `README.md` files keep working through the Description surface; existing legacy `document` schema data is preserved until a future schema save removes it.

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

[0.0.8]: https://github.com/venmakli/svode/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/venmakli/svode/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/venmakli/svode/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/venmakli/svode/releases/tag/v0.0.5
