# svode command reference

`svode [--project <path>] [--space <root|space-id>] [--json] <noun> <verb> [--flags]`

Global selectors may appear before or after the command. The target is resolved once before the command runs and stays frozen:

- `--project` is absolute or relative to the current directory. Without it, the nearest directory containing `.svode/config.json` among the current directory and its ancestors is the Project; when that directory is a registered child Space of its parent Project, the parent is the Project. No registry, recent project or desktop window is consulted, and nothing is scaffolded.
- `--space` is `root` for the Project Space or a registered child Space id. Without it, the most specific ready child Space containing the current directory is used, otherwise `root`.
- Paths are relative to the selected Space. `..`, absolute paths, `.git/**`, `.svode/**` and symlink escapes are rejected by the shared path policy.

## Output and exit codes

- stdout carries only the result; warnings, diagnostics and usage go to stderr.
- With `--json`, stdout holds exactly one JSON object. Success: `{"schemaVersion":1,"ok":true,"target":{…},…result}`, where `…result` is the structured result of the shared operation in the same shape as the MCP `structuredContent` of that capability. Failure: `{"schemaVersion":1,"ok":false,"error":{"code":"…","message":"…","target":{…},…evidence}}`; `target` holds only the selectors known at the moment of failure.
- `target` holds the resolved `projectPath`, `spaceId`, `spacePath` plus command selectors such as `path`, `collection` or `id`.
- Exit `0` — success (including warnings); `1` — operation failure, including `SOURCE_BUSY` and `SOURCE_STALE`; `2` — grammar or input failure (`INVALID_ARGUMENT`, `INPUT_UNREADABLE`).
- Lists keep the bounds of the shared operation: `--limit` default 50, max 200, `--offset` from 0; Knowledge commands have their own limits.

## Runtime modes

Each command runs on the Svode headless runtime shared with `svode-mcp --project`: it opens only what its capability needs and closes it before exit, also on SIGINT/SIGTERM (exit 130/143); a write already inside its source phase completes or rolls back before the command stops. This build serves every command: reads from project sources, including `collection check`, from the index, from Git and from the Actor catalog; body writes; metadata, field, schema column and view changes; creation, deletion, structural changes and reordering; `asset import`; Routine definitions (`routine …`), whose operational store of the owner is opened only by a Routine command; `git access verify`; and `app validate`, which needs no Project. `svode doctor` lists the served capabilities. Writes read and validate their input first, so grammar and input failures still exit 2.

Index-backed commands (`collection query`, `search`, `knowledge …`) check the index of their Spaces against the files before answering, with no watcher: a missing index is built, an incompatible or corrupt one is moved aside and rebuilt, and each command runs one check. Their result carries `index`: `{"status":"fresh"|"partial","verifiedAt":"<time of the check>","diagnostics":[…]}`, where `partial` means some sources could not be read and their earlier rows are kept. An index that cannot be prepared fails with `INDEX_UNAVAILABLE` and its diagnostics, never with an empty list. `space list`, `project info` and `doctor` report repository access from the evidence store shared with the desktop app, without contacting the remote; a repository never checked is `unknown` with reason `not_checked`. A write to a repository with a remote is allowed only while it is `local` or freshly `writable`: otherwise it fails before any effect with `REPOSITORY_ACCESS_DENIED`, its `status`, `reason` and a `hint`, and `git access verify` records new evidence.

Before a write, the index of the Spaces it changes is checked against the files like before an index-backed read, so the Routine events of a Collection item describe only the change of the command, not edits made meanwhile by other programs. The events are recorded for the desktop app when automatic Routines are enabled for that Collection on this device; `svode` never runs a Routine.

Device-local settings, such as that evidence store, are found in the OS config directory under the product identifier `app.svode.desktop`, like the desktop app. `SVODE_PRODUCT_IDENTIFIER` overrides the identifier for dev/QA builds that run under another one (one path segment); it never selects a target.

| Command | Capability | Standalone in this build |
|---|---|---|
| `project info` | `get_project_info` | yes |
| `space list` | `list_spaces` | yes |
| `space readme read` | `read_space_readme` | yes |
| `page read --path` | `read_page` (source read with `sourceVersion`, no index or store) | yes |
| `page list [--path <dir>] [--limit --offset]` | `list_pages` | yes |
| `collection list` | `list_collections` | yes |
| `collection schema --collection` | `get_collection_schema` | yes |
| `collection query --collection [--filter-file] [--sort-file] [--limit --offset]` | `query_collection_items` | yes |
| `collection readme read --collection` | `read_collection_readme` | yes |
| `item read --path` | `read_collection_item` | yes |
| `actor list [--all-time]` | `list_actors` | yes |
| `search <query> [--limit --offset]` | `search_pages` | yes |
| `knowledge search <query> [--scope] [--kind …] [--limit]` | `search_knowledge` | yes |
| `knowledge node --id [--scope]` | `get_knowledge_node` | yes |
| `knowledge neighbors --id [--scope] [--edge-kind …] [--limit]` | `get_knowledge_neighbors` | yes |
| `knowledge context <query> [--scope] [--limit --text-budget] [--kind …]` | `get_related_context` | yes |
| `knowledge status [--scope]` | `get_knowledge_status` | yes |
| `git status` | `get_git_status` | yes |
| `git access verify` | CLI diagnostics: explicit verification of repository access | yes |
| `page create --parent <dir\|""> --title [--body-file\|--body] [--icon --description --cover-file] [--properties-file]` | `create_page` (Page, or Collection item under a Collection) | yes |
| `page write --path --body-file\|--body --source-version <token> [--title]` | `write_page` | yes |
| `page meta set --path [metadata patch]` | `update_page_metadata` | yes |
| `space readme write --body-file\|--body --source-version <token> [--title]` | `write_space_readme` | yes |
| `space meta set [metadata patch]` | `update_space_metadata` | yes |
| `collection readme write --collection --body-file\|--body --source-version <token> [--title]` | `write_collection_readme` | yes |
| `collection meta set --collection [metadata patch]` | `update_collection_metadata` | yes |
| `item write --path --body-file\|--body --source-version <token>` | `update_collection_item_body` | yes |
| `item fields set --path --fields-file` | `update_collection_item_fields` | yes |
| `item meta set --path [metadata patch]` | `update_collection_item_metadata` | yes |
| `collection create --parent <dir\|""> --title [--body-file\|--body] [--icon --description --cover-file] [--columns-file] [--views-file]` | `create_collection` | yes |
| `collection delete --collection` | `delete_collection` | yes |
| `collection check [--collection]` | `validate_collection_integrity` | yes |
| `collection column add --collection --column-file` | `add_collection_column` | yes |
| `collection column update --collection --name --patch-file` | `update_collection_column` | yes |
| `collection column delete --collection --name [--delete-values]` | `delete_collection_column` | yes |
| `collection view add --collection --view-file [--position]` | `add_collection_view` | yes |
| `collection view update --collection --name --patch-file` | `update_collection_view` | yes |
| `collection view delete --collection --name` | `delete_collection_view` | yes |
| `content rename --path --to` | `rename_content` | yes |
| `content move --path --to-parent <dir\|"">` | `move_content` | yes |
| `content reorder --parent <dir\|""> --child …` | `reorder_content` | yes |
| `content convert --path --to leaf` | `convert_page_to_leaf` | yes |
| `content convert --path --to collection` | `convert_to_collection` | yes |
| `page delete --path` | `delete_page` | yes |
| `item delete --path` | `delete_collection_item` | yes |
| `space reorder --id …` | `reorder_spaces` (Project level; `--space` is not used) | yes |
| `asset import --path <content.md> --file <local> [--name]` | `import_asset` | yes |
| `app validate --file <app.yaml\|->` | `validate_app_manifest` | yes, without a Project |
| `routine list [--collection] [--limit --offset]` | `list_routines` | yes |
| `routine get [--collection] --id` | `get_routine` | yes |
| `routine create [--collection] --definition-file [--confirm-automatic-execution]` | `create_routine` | yes |
| `routine update [--collection] --id --fingerprint --definition-file [--confirm-automatic-execution]` | `update_routine` | yes |
| `routine delete [--collection] --id --fingerprint` | `delete_routine` | yes |
| `guide` | `get_svode_guide` plus files-first rules | yes, without a Project |
| `doctor` | CLI diagnostics | yes, target failures are part of the result |

Flags follow the tool arguments: `collectionPath → --collection`, `path`, `from` and `contentPath → --path`, `sourcePath → --file`, `fileName → --name`, `yaml → --file`, `parentPath → --parent`, `toParent → --to-parent`, `columnName`/`viewName → --name`, `orderedChildren → --child`, `orderedSpaceIds → --id`, `nodeId → --id`, `routineId → --id`, `expectedFingerprint → --fingerprint`, `definition → --definition-file`, `nodeKinds → --kind`, `edgeKinds → --edge-kind`, camelCase → kebab-case. Repeated flags keep their order. `--scope` is `space` (default) or `project`.

## Structured input

Filter and sort of `collection query` are JSON arrays of the shared query shape, read with `--filter-file <path|->` and `--sort-file <path|->`. A relative path is read from the current directory, `-` reads stdin, and a command reads stdin at most once. Unreadable input is `INPUT_UNREADABLE`, invalid JSON or two `-` are `INVALID_ARGUMENT`; both exit 2 before the command runs.

## Writes

Page, owner and item writes run the shared operation of the same capability: validation, Desktop naming and rename, link and relation effects, Collection defaults and schema validation, and authorization of every affected repository before the first write. `svode` never commits to Git.

- Body: `--body-file <path>` or `--body-file -` for stdin; `--body <text>` for short inline text. Exactly one is required for `write` commands and optional for `page create`. An empty body is valid.
- Source version: every body write (`page write`, `item write`, `space readme write`, `collection readme write`) requires `--source-version <token>`, the opaque `sourceVersion` of the JSON result of the read of that source (`page read`, `item read`, the README reads) or of the previous write, create, metadata or fields result of the same source; store and pass it whole. A missing flag is `INVALID_ARGUMENT` (exit 2) before anything runs. `page create` takes no version. Every read, write, create, metadata and fields result carries the top-level `sourceVersion` of the resulting source, and human output of a read prints it under the path.
- Safe cycle: `page read --json` → edit the body → `page write --source-version <sourceVersion>`. `SOURCE_STALE` (exit 1, `path` in the error) means the source changed after your read: nothing was written and no new version is returned, so read it again and reapply your change to the current text; never resend the old body with a fresh version. `SOURCE_BUSY` (exit 1, `path`) means another Svode operation is writing the same repository: nothing was written; retry later. If a result is lost, read the source and compare its `sourceVersion` before any retry.
- Direct edits: an agent with file access edits the text below the frontmatter of an existing Page, item or README with its own tools, keeping the frontmatter byte for byte, the line endings and the file location; Svode and the desktop app pick the edit up. The body write commands are the path for clients without file access. Frontmatter, names, structure, schema, attachments and `.svode`, `.routines`, `.templates` always change through Svode commands.
- Structured input: `--cover-file`, `--properties-file`, `--fields-file` take a JSON object from a file or `-`. A command reads stdin at most once.
- Metadata patch of `meta set`: `--title`, `--icon`, `--description`, `--cover-file` write a value; `--clear-icon`, `--clear-description`, `--clear-cover` clear the field; a missing flag keeps it. `--title` always means a title change with managed rename.
- Human output: the summary line, then each changed path. Warnings of an applied outcome (such as `filename_rename_collision`) go to stderr and keep exit 0; the JSON result carries them in `warnings`.
- A rejected write is exit 1 with the code of the shared operation, and the whole request is rolled back. `PAGE_WRITE_RECOVERY_FAILED` means restoration failed; its message names the unrestored paths, so inspect them before any retry. After any failure reread the source and apply the intent again; do not delete or hand-repair `.svode` metadata.
- There is no `--force` and no confirmation.

## Structural commands

Collection create/delete, schema columns and views, content rename/move/reorder/convert, Page and item delete and child Space order run the shared structural operation of the same capability: link, backlink and relation rewrites, relation cleanup on delete, sidebar order, conversion effects, schema normalization and reverse relation schema writes, and authorization of every affected repository before the first write. `svode` never commits to Git.

- Structured input: `--columns-file` and `--views-file` take a JSON array, `--column-file`, `--view-file`, `--patch-file` and `--cover-file` a JSON object, from a file or `-`. A command reads stdin at most once.
- Ordered lists are repeated flags in their order: `content reorder --child a.md --child b.md` is the complete order of the direct children as `page list` shows them (directory-backed Pages and Collections use their `README.md` path); `space reorder --id a --id b` is the complete order of the child Spaces without `root`.
- `column delete` keeps stored values unless `--delete-values` is set. `view add --position` counts from 0; the end by default.
- Destructive targets are exact selectors; there is no confirmation and no `--force`. A rejected command is exit 1 with the code of the shared operation (for example `NOT_A_STANDALONE_PAGE`, `INVALID_COLLECTION_CONVERSION`, `INVALID_SPACE_ORDER`, `REPOSITORY_ACCESS_DENIED`). Reread the structure before trying again.
- `collection check` is read-only: it reports `errorCount`, `warningCount` and `issuesBySeverity` for relation targets, stored item references and stale order entries of one Collection or of every Collection in the Space. Issues are a result, not a failure (exit 0). Run it after structural files changed outside Svode (by hand, Git or another program).
- Human output: the summary line, then each changed path; `collection check` prints the counts, then one line per issue.

The JSON result is the MCP `structuredContent` of the capability, for example `page write` returns `path`, `newPath` (only after a performed rename), `sourceVersion`, `changedPaths` and `warnings`, plus `schemaVersion`, `ok` and `target` (with `path`, `collection`, `parent` or `name` selectors).

## Assets and Apps

`asset import` copies one local regular file next to existing Markdown content through the shared managed import: `--path` is a Page, Collection item, Space README or Collection README relative to the selected Space; `--file` is absolute or relative to the current directory and is copied, never moved. Directories, symbolic links and stdin are not accepted. The copy is stored by the asset routing of its Space (local with a `.gitignore` entry, in Git, or Git LFS); a Git LFS route that is not ready refuses before any write. Readiness is the same live check the desktop app runs: an S3-backed route needs the S3 setup saved for this device with its credentials in the OS keychain, a remote route needs Git LFS to reach `origin`. A leaf Page becomes directory-backed first, with its links rewritten. The import authorizes the affected repository before the first write and never commits to Git; it changes no body or cover.

- JSON result: `spaceId`, canonical `contentPath` (use it for the next command), `attachmentPath` and `coverPath` relative to the Space, `markdownUrl` relative to the content, `fileName`, `mime`, `sizeBytes`, `changedPaths`.
- Human output: the summary line, `contentPath`, `attachmentPath`, `markdownUrl`, `coverPath`, then each changed path.
- Failures keep the codes of the shared operation: `INVALID_PATH`, `PATH_FORBIDDEN`, `PATH_NOT_ACCESSIBLE` (missing content, missing or non-regular source), `REPOSITORY_ACCESS_DENIED`, `SVODE_ERROR` with a `Storage:` message for an unsupported format or a Git LFS route that is not ready.

`app validate --file <app.yaml|->` validates a complete app.yaml candidate from a file or stdin with the parser of the Svode App host. It needs no Project, ignores `--project` and `--space`, writes nothing, launches no App and reads no Variable or Secret value. The result is `valid`, `runtimeType`, `settingsReferences` and `diagnostics` (`code`, `path`, `message`); an invalid manifest is a result with exit 0, not a failure. Unreadable or non-UTF-8 input is `INPUT_UNREADABLE` (exit 2). Human output: `valid <type> App` and one `setting <NAME>` line per reference, or `invalid` and one line per diagnostic.

## Routines

Routine commands read and change Routine definitions through the shared Routine service. The owner is always explicit: the selected Space (`--space`, or the Space containing the current directory) is passed to the operation, and `--collection <dir>` selects one of its Collections instead. `.routines` is not an owner address. `routine run` is not part of this build: `svode` never starts a Routine, a scheduler or an agent.

- `routine list` returns bounded summaries of the owner, including invalid definitions and their diagnostics, with `total`/`limit`/`offset`, `catalogFingerprint` and the exact-owner device authority evidence (`automaticAuthorityEnabled`, `authorityDiagnostics`); it never returns the Markdown body. `routine get --id` returns the normalized `definition`, `diagnostics`, `valid` and the `fingerprint` of the definition.
- `routine create` and `routine update` take a complete definition as a JSON object (`name`, `description`, `enabled`, `trigger`, `action`, `body`) from `--definition-file <path|->`. Unknown fields are rejected by the shared decode (`SERIALIZATION_ERROR`) and an invalid definition by the service (`ROUTINE_INVALID` with `diagnostics`), before any write. The file name follows the Routine name; a taken name is `ROUTINE_NAME_CONFLICT`.
- An enabled schedule or event Routine needs `--confirm-automatic-execution`, otherwise `ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED`. Saving never starts the Routine and never changes the automatic authority of this device.
- `routine update` and `routine delete` are compare-and-set: pass `--id` and the `--fingerprint` of your last read. A changed definition fails with `ROUTINE_FINGERPRINT_CONFLICT` and `currentFingerprint`; a missing one with `ROUTINE_NOT_FOUND`. Read it again and reapply the intent. Delete keeps run history and does not cancel an active run.
- The owner repository is authorized before the first write, and nothing is committed to Git.
- `lastRunAt` and `lastRunOrigin` come from the run history the store keeps; `svode` has no evidence of a live run and never reports one as running or finished.
- A process started from a Routine launch of the desktop app inherits its caller token (`SVODE_MCP_ROUTINE_CALLER_TOKEN`) and keeps the Routine origin: saving an enabled schedule or event Routine fails with `ROUTINE_RECURSION_GUARD`, even with `--confirm-automatic-execution`.
- JSON result: the `structuredContent` of the capability, for mutations `owner`, `routineId`, `path`, `fingerprint` (create/update), `catalogFingerprint`, `changedPaths`, `detail` (create/update) and `warnings`. Human output: `routine list` prints `routineId name trigger enabled|disabled|invalid fingerprint` per Routine, `routine get` the detail as JSON, mutations the summary line, `routineId`, `fingerprint` and each changed path.

## page read

`svode [--project <path>] [--space <root|space-id>] page read --path <relative.md> [--json]`

Reads one standalone Page from its Markdown source through the shared `read_page` operation, without the desktop app, the index or Routine stores. A directory-backed Page is read through its `README.md`; a file inside a registered child Space is read in that Space, not through the root. Human output prints the scoped Page path, a `sourceVersion: <token>` line, a blank line and the body; warnings go to stderr. JSON output:

```json
{ "schemaVersion": 1, "ok": true,
  "target": { "projectPath": "…", "spaceId": "root", "spacePath": "…", "path": "notes/today.md" },
  "page": { "meta": { "title": "…", "created": "…", "updated": "…", … }, "body": "…", "path": "notes/today.md" },
  "sourceVersion": "…" }
```

`page` has the same shape as the MCP `read_page` result. `sourceVersion` is an opaque token of the exact bytes read; store it whole and pass it to `page write --source-version`. Malformed frontmatter is a successful read with a `malformed_frontmatter` warning, and the source is never rewritten. Failures keep the codes of the shared operation: `INVALID_PATH`, `PATH_FORBIDDEN`, `NOT_A_STANDALONE_PAGE`, `FILE_NOT_FOUND`, `INVALID_SOURCE_ENCODING`, `PATH_NOT_ACCESSIBLE`.

## git access verify

`svode [--project <path>] [--space <root|space-id>] git access verify [--json]` verifies write access to the `origin` remote of the selected Space with the same shared verification as the desktop app: it pushes a Svode service ref and reads it back, leaves branches, the index and the working tree untouched and commits nothing. The result is recorded in the evidence store shared with the desktop app and returned as `repositoryAccess` (`repositoryId`, `status`, `reason`, `checkedAt`, `expiresAt`): `local` without a remote, `writable`, `read_only`, or `unknown` with its reason (`auth_required`, `offline_or_timeout`, `ambiguous_rejection`, …). Every access state is a result with exit 0; a target failure or a verification that cannot run (for example without Git) is exit 1 with its code. Human output: `repository access: <status> (<reason>)`. There is no MCP tool for it: an MCP-only client gets `REPOSITORY_ACCESS_DENIED` with a hint to this command or the desktop app.

## doctor

`svode doctor [--project <path>]` reports, without opening an index or store: `version`; `project` (`ok`, or the target error code and message); `spaces` from `space list`, each with `index.present` checked by file presence; `git` availability and versions; `runtime.servedTools`. It exits 0 whenever the command itself runs.

## integration

`svode [--project <path>] integration <connect|disconnect|status|sync> [--json]` manages the connection of agent clients (`claude-code`, `codex`) to the Svode runtime in `~/.svode`, with the same connection manager as the desktop app Settings and `svode-mcp install | remove`. It changes user-level client configs, not Project data, and opens no Project; `--project` (or the Project around the current directory) only selects whose project and local client entries are checked for conflicts.

- `connect <client>` connects the whole integration: Claude Code gets the plugin `~/.claude/skills/svode` → `~/.svode/current/plugins/svode` (skill, `svode` through the plugin `bin/`, MCP server), Codex gets the skill `~/.agents/skills/svode` and a managed `[mcp_servers.svode]` entry in `~/.codex/config.toml` that starts `~/.svode/bin/svode-mcp` in automatic mode. Every conflict is checked before the first write: a custom `svode` entry (`CUSTOM_CONFIG_CONFLICT`), another skill at the same path (`SKILL_CONFLICT`), a project or local entry that overrides the user one (`HIGHER_PRECEDENCE_CONFLICT`); without a runtime in `~/.svode` it fails with `RUNTIME_UNAVAILABLE`. No approval setting or `allowed-tools` is written, and every other part of a config stays as it was.
- `disconnect <client>` or `disconnect --all` removes only what Svode added; the shared skill goes with the last client that reads it.
- `status` reports the runtime (`runtime`) and every client (`clients`: `installed` for connected, `complete`, `version`, `issues` with codes such as `custom_conflict`, `skill_conflict`, `client_policy_blocked`, `runtime_unavailable`, `incomplete`, `mcp_start_failed`, and `artifacts`).
- `sync` completes every connected client, as the desktop app does at start: a managed MCP entry of a previous desktop app becomes a full connection and a missing artifact is restored. It fails with `RECONCILE_FAILED` when a client cannot be completed. The standalone installer runs it after installing the active runtime and runs `disconnect --all` before removing it.

Agent sessions that are already open get a new skill and MCP server after a restart; `svode` itself runs the active version at once.

## Codes

Context and input codes are owned by the CLI; every other code comes unchanged from the shared operation (`INVALID_PATH`, `PATH_FORBIDDEN`, `PATH_NOT_ACCESSIBLE`, `FILE_NOT_FOUND`, `INVALID_SOURCE_ENCODING`, `NOT_A_STANDALONE_PAGE`, `NOT_A_COLLECTION_ITEM`, `CONTENT_OWNER_MISMATCH`, `SPACE_NOT_FOUND`, `SOURCE_BUSY` and `SOURCE_STALE` with the target `path`, `INDEX_UNAVAILABLE` with `diagnostics` naming each Space and cause, `INDEX_ERROR` for a failed index query, `IO_ERROR`, Knowledge codes and others).

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | Unknown command/flag, missing flag, invalid JSON input or stdin named twice (exit 2) |
| `INPUT_UNREADABLE` | An input file or stdin cannot be read, or is not UTF-8 (exit 2) |
| `PROJECT_UNAVAILABLE` | The Project directory or `.svode/config.json` is missing or unreadable, or no Project contains the current directory |
| `INVALID_PROJECT_CONFIG` | `.svode/config.json` is not a valid Project config |
| `SPACE_UNAVAILABLE` | Unknown, missing or broken child Space |

## Help and version

`svode --help`, `svode <noun> --help`, `svode <noun> <verb> --help` and `svode --version` work without a Project, and every help page names a working example. Mutating commands describe the safe read → edit → write cycle and recovery, body writes with `--source-version` and the direct-edit alternative.

## Installation

The desktop app bundle ships `svode` and `svode-mcp` of the same version as sidecars next to its own executable (Linux packages place sidecars in `/usr/bin`). For scripts and CI both build without the desktop app: `cargo build --release -p svode-cli -p svode-mcp` in the Svode repository gives standalone binaries that need neither the desktop app nor its GUI libraries, and `node scripts/smoke-standalone.mjs <dir>` checks such binaries against a fresh Project. The standalone installer (`scripts/install.sh <archive>`) installs both into `~/.svode` with `PATH` setup, updates and removal; `svode integration` connects agent clients to it.
