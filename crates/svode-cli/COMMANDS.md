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
- Exit `0` — success (including warnings); `1` — operation failure, including `MODE_UNAVAILABLE`; `2` — grammar or input failure (`INVALID_ARGUMENT`, `INPUT_UNREADABLE`).
- Lists keep the bounds of the shared operation: `--limit` default 50, max 200, `--offset` from 0; Knowledge commands have their own limits.

## Runtime modes

This build runs standalone reads answered from project sources, including `collection check`, and `app validate`, which needs no Project. Commands that need the index, the Git runtime, the Actor catalog, the Routine stores or the mutation runtime of the headless runtime answer `MODE_UNAVAILABLE` (exit 1) and run nothing; `svode doctor` lists the served capabilities. Writes read and validate their input first, so grammar and input failures still exit 2.

| Command | Capability | Standalone in this build |
|---|---|---|
| `project info` | `get_project_info` | yes |
| `space list` | `list_spaces` | yes; repository access reports `MODE_UNAVAILABLE` per Space |
| `space readme read` | `read_space_readme` | yes |
| `page read --path` | `read_page` (source-only read with `sourceVersion`) | yes |
| `page list [--path <dir>] [--limit --offset]` | `list_pages` | yes |
| `collection list` | `list_collections` | yes |
| `collection schema --collection` | `get_collection_schema` | yes |
| `collection query --collection [--filter-file] [--sort-file] [--limit --offset]` | `query_collection_items` | no |
| `collection readme read --collection` | `read_collection_readme` | yes |
| `item read --path` | `read_collection_item` | yes |
| `actor list [--all-time]` | `list_actors` | no |
| `search <query> [--limit --offset]` | `search_pages` | no |
| `knowledge search <query> [--scope] [--kind …] [--limit]` | `search_knowledge` | no |
| `knowledge node --id [--scope]` | `get_knowledge_node` | no |
| `knowledge neighbors --id [--scope] [--edge-kind …] [--limit]` | `get_knowledge_neighbors` | no |
| `knowledge context <query> [--scope] [--limit --text-budget] [--kind …]` | `get_related_context` | no |
| `knowledge status [--scope]` | `get_knowledge_status` | no |
| `git status` | `get_git_status` | no |
| `page create --parent <dir\|""> --title [--body-file\|--body] [--icon --description --cover-file] [--properties-file]` | `create_page` (Page, or Collection item under a Collection) | no |
| `page write --path --body-file\|--body [--title]` | `write_page` | no |
| `page meta set --path [metadata patch]` | `update_page_metadata` | no |
| `space readme write --body-file\|--body [--title]` | `write_space_readme` | no |
| `space meta set [metadata patch]` | `update_space_metadata` | no |
| `collection readme write --collection --body-file\|--body [--title]` | `write_collection_readme` | no |
| `collection meta set --collection [metadata patch]` | `update_collection_metadata` | no |
| `item write --path --body-file\|--body` | `update_collection_item_body` | no |
| `item fields set --path --fields-file` | `update_collection_item_fields` | no |
| `item meta set --path [metadata patch]` | `update_collection_item_metadata` | no |
| `collection create --parent <dir\|""> --title [--body-file\|--body] [--icon --description --cover-file] [--columns-file] [--views-file]` | `create_collection` | no |
| `collection delete --collection` | `delete_collection` | no |
| `collection check [--collection]` | `validate_collection_integrity` | yes |
| `collection column add --collection --column-file` | `add_collection_column` | no |
| `collection column update --collection --name --patch-file` | `update_collection_column` | no |
| `collection column delete --collection --name [--delete-values]` | `delete_collection_column` | no |
| `collection view add --collection --view-file [--position]` | `add_collection_view` | no |
| `collection view update --collection --name --patch-file` | `update_collection_view` | no |
| `collection view delete --collection --name` | `delete_collection_view` | no |
| `content rename --path --to` | `rename_content` | no |
| `content move --path --to-parent <dir\|"">` | `move_content` | no |
| `content reorder --parent <dir\|""> --child …` | `reorder_content` | no |
| `content convert --path --to leaf` | `convert_page_to_leaf` | no |
| `content convert --path --to collection` | `convert_to_collection` | no |
| `page delete --path` | `delete_page` | no |
| `item delete --path` | `delete_collection_item` | no |
| `space reorder --id …` | `reorder_spaces` (Project level; `--space` is not used) | no |
| `asset import --path <content.md> --file <local> [--name]` | `import_asset` | no |
| `app validate --file <app.yaml\|->` | `validate_app_manifest` | yes, without a Project |
| `routine list [--collection] [--limit --offset]` | `list_routines` | no |
| `routine get [--collection] --id` | `get_routine` | no |
| `routine create [--collection] --definition-file [--confirm-automatic-execution]` | `create_routine` | no |
| `routine update [--collection] --id --fingerprint --definition-file [--confirm-automatic-execution]` | `update_routine` | no |
| `routine delete [--collection] --id --fingerprint` | `delete_routine` | no |
| `guide` | `get_svode_guide` plus files-first rules | yes, without a Project |
| `doctor` | CLI diagnostics | yes, target failures are part of the result |

Flags follow the tool arguments: `collectionPath → --collection`, `path`, `from` and `contentPath → --path`, `sourcePath → --file`, `fileName → --name`, `yaml → --file`, `parentPath → --parent`, `toParent → --to-parent`, `columnName`/`viewName → --name`, `orderedChildren → --child`, `orderedSpaceIds → --id`, `nodeId → --id`, `routineId → --id`, `expectedFingerprint → --fingerprint`, `definition → --definition-file`, `nodeKinds → --kind`, `edgeKinds → --edge-kind`, camelCase → kebab-case. Repeated flags keep their order. `--scope` is `space` (default) or `project`.

## Structured input

Filter and sort of `collection query` are JSON arrays of the shared query shape, read with `--filter-file <path|->` and `--sort-file <path|->`. A relative path is read from the current directory, `-` reads stdin, and a command reads stdin at most once. Unreadable input is `INPUT_UNREADABLE`, invalid JSON or two `-` are `INVALID_ARGUMENT`; both exit 2 before the command runs.

## Writes

Page, owner and item writes run the shared operation of the same capability: validation, Desktop naming and rename, link and relation effects, Collection defaults and schema validation, and authorization of every affected repository before the first write. `svode` never commits to Git.

- Body: `--body-file <path>` or `--body-file -` for stdin; `--body <text>` for short inline text. Exactly one is required for `write` commands and optional for `page create`. An empty body is valid.
- Structured input: `--cover-file`, `--properties-file`, `--fields-file` take a JSON object from a file or `-`. A command reads stdin at most once.
- Metadata patch of `meta set`: `--title`, `--icon`, `--description`, `--cover-file` write a value; `--clear-icon`, `--clear-description`, `--clear-cover` clear the field; a missing flag keeps it. `--title` always means a title change with managed rename.
- Human output: the summary line, then each changed path. Warnings of an applied outcome (such as `filename_rename_collision`) go to stderr and keep exit 0; the JSON result carries them in `warnings`.
- A rejected write is exit 1 with the code of the shared operation, and the whole request is rolled back. `PAGE_WRITE_RECOVERY_FAILED` means restoration failed; its message names the unrestored paths, so inspect them before any retry. After any failure reread the source and apply the intent again; do not delete or hand-repair `.svode` metadata.
- There is no `--force` and no confirmation. Busy/stale preconditions are not part of this build.

## Structural commands

Collection create/delete, schema columns and views, content rename/move/reorder/convert, Page and item delete and child Space order run the shared structural operation of the same capability: link, backlink and relation rewrites, relation cleanup on delete, sidebar order, conversion effects, schema normalization and reverse relation schema writes, and authorization of every affected repository before the first write. `svode` never commits to Git.

- Structured input: `--columns-file` and `--views-file` take a JSON array, `--column-file`, `--view-file`, `--patch-file` and `--cover-file` a JSON object, from a file or `-`. A command reads stdin at most once.
- Ordered lists are repeated flags in their order: `content reorder --child a.md --child b.md` is the complete order of the direct children as `page list` shows them (directory-backed Pages and Collections use their `README.md` path); `space reorder --id a --id b` is the complete order of the child Spaces without `root`.
- `column delete` keeps stored values unless `--delete-values` is set. `view add --position` counts from 0; the end by default.
- Destructive targets are exact selectors; there is no confirmation and no `--force`. A rejected command is exit 1 with the code of the shared operation (for example `NOT_A_STANDALONE_PAGE`, `INVALID_COLLECTION_CONVERSION`, `INVALID_SPACE_ORDER`, `REPOSITORY_ACCESS_DENIED`). Reread the structure before trying again.
- `collection check` is read-only: it reports `errorCount`, `warningCount` and `issuesBySeverity` for relation targets, stored item references and stale order entries of one Collection or of every Collection in the Space. Issues are a result, not a failure (exit 0). Run it after a deliberate raw structural edit.
- Human output: the summary line, then each changed path; `collection check` prints the counts, then one line per issue.

The JSON result is the MCP `structuredContent` of the capability, for example `page write` returns `path`, `newPath` (only after a performed rename), `changedPaths` and `warnings`, plus `schemaVersion`, `ok` and `target` (with `path`, `collection`, `parent` or `name` selectors).

## Assets and Apps

`asset import` copies one local regular file next to existing Markdown content through the shared managed import: `--path` is a Page, Collection item, Space README or Collection README relative to the selected Space; `--file` is absolute or relative to the current directory and is copied, never moved. Directories, symbolic links and stdin are not accepted. The copy is stored by the asset routing of its Space (local with a `.gitignore` entry, in Git, or Git LFS); a Git LFS route that is not ready refuses before any write. A leaf Page becomes directory-backed first, with its links rewritten. The import authorizes the affected repository before the first write and never commits to Git; it changes no body or cover.

- JSON result: `spaceId`, canonical `contentPath` (use it for the next command), `attachmentPath` and `coverPath` relative to the Space, `markdownUrl` relative to the content, `fileName`, `mime`, `sizeBytes`, `changedPaths`.
- Human output: the summary line, `contentPath`, `attachmentPath`, `markdownUrl`, `coverPath`, then each changed path.
- Failures keep the codes of the shared operation: `INVALID_PATH`, `PATH_FORBIDDEN`, `PATH_NOT_ACCESSIBLE` (missing content, missing or non-regular source), `REPOSITORY_ACCESS_DENIED`, `SVODE_ERROR` with a `Storage:` message for an unsupported format or a Git LFS route that is not ready.

`app validate --file <app.yaml|->` validates a complete app.yaml candidate from a file or stdin with the parser of the Svode App host. It needs no Project, ignores `--project` and `--space`, writes nothing, launches no App and reads no Variable or Secret value. The result is `valid`, `runtimeType`, `settingsReferences` and `diagnostics` (`code`, `path`, `message`); an invalid manifest is a result with exit 0, not a failure. Unreadable or non-UTF-8 input is `INPUT_UNREADABLE` (exit 2). Human output: `valid <type> App` and one `setting <NAME>` line per reference, or `invalid` and one line per diagnostic.

## Routines

Routine commands read and change Routine definitions through the shared Routine service. The owner is always explicit: the selected Space (`--space`, or the Space containing the current directory) is passed to the operation, and `--collection <dir>` selects one of its Collections instead. `.routines` is not an owner address. `routine run` is not part of this build.

- `routine list` returns bounded summaries of the owner, including invalid definitions and their diagnostics, with `total`/`limit`/`offset`, `catalogFingerprint` and the exact-owner device authority evidence (`automaticAuthorityEnabled`, `authorityDiagnostics`); it never returns the Markdown body. `routine get --id` returns the normalized `definition`, `diagnostics`, `valid` and the `fingerprint` of the definition.
- `routine create` and `routine update` take a complete definition as a JSON object (`name`, `description`, `enabled`, `trigger`, `action`, `body`) from `--definition-file <path|->`. Unknown fields are rejected by the shared decode (`SERIALIZATION_ERROR`) and an invalid definition by the service (`ROUTINE_INVALID` with `diagnostics`), before any write. The file name follows the Routine name; a taken name is `ROUTINE_NAME_CONFLICT`.
- An enabled schedule or event Routine needs `--confirm-automatic-execution`, otherwise `ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED`. Saving never starts the Routine and never changes the automatic authority of this device.
- `routine update` and `routine delete` are compare-and-set: pass `--id` and the `--fingerprint` of your last read. A changed definition fails with `ROUTINE_FINGERPRINT_CONFLICT` and `currentFingerprint`; a missing one with `ROUTINE_NOT_FOUND`. Read it again and reapply the intent. Delete keeps run history and does not cancel an active run.
- The owner repository is authorized before the first write, and nothing is committed to Git.
- JSON result: the `structuredContent` of the capability, for mutations `owner`, `routineId`, `path`, `fingerprint` (create/update), `catalogFingerprint`, `changedPaths`, `detail` (create/update) and `warnings`. Human output: `routine list` prints `routineId name trigger enabled|disabled|invalid fingerprint` per Routine, `routine get` the detail as JSON, mutations the summary line, `routineId`, `fingerprint` and each changed path.

## page read

`svode [--project <path>] [--space <root|space-id>] page read --path <relative.md> [--json]`

Reads one standalone Page from its Markdown source, without the desktop app, the index or Routine stores. A directory-backed Page is read through its `README.md`. Human output prints the scoped Page path, a blank line and the body. JSON output:

```json
{ "schemaVersion": 1, "ok": true,
  "target": { "projectPath": "…", "spaceId": "root", "spacePath": "…", "path": "notes/today.md" },
  "page": { "meta": { "title": "…", "created": "…", "updated": "…", … }, "body": "…", "path": "notes/today.md" },
  "sourceVersion": "…" }
```

`page` has the same shape as the MCP `read_page` result. `sourceVersion` is an opaque token of the exact bytes read; store it whole. Malformed frontmatter is a successful read with a `malformed_frontmatter` warning, and the source is never rewritten.

## doctor

`svode doctor [--project <path>]` reports, without opening an index or store: `version`; `project` (`ok`, or the target error code and message); `spaces` from `space list`, each with `index.present` checked by file presence; `git` availability and versions; `runtime.servedTools`. It exits 0 whenever the command itself runs.

## Codes

Context and input codes are owned by the CLI; every other code comes unchanged from the shared operation (`INVALID_PATH`, `PATH_FORBIDDEN`, `PATH_NOT_ACCESSIBLE`, `FILE_NOT_FOUND`, `NOT_A_STANDALONE_PAGE`, `NOT_A_COLLECTION_ITEM`, `CONTENT_OWNER_MISMATCH`, `SPACE_NOT_FOUND`, `INDEX_ERROR`, `IO_ERROR`, Knowledge codes and others).

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | Unknown command/flag, missing flag, invalid JSON input or stdin named twice (exit 2) |
| `INPUT_UNREADABLE` | An input file or stdin cannot be read, or is not UTF-8 (exit 2) |
| `PROJECT_UNAVAILABLE` | The Project directory or `.svode/config.json` is missing or unreadable, or no Project contains the current directory |
| `INVALID_PROJECT_CONFIG` | `.svode/config.json` is not a valid Project config |
| `SPACE_UNAVAILABLE` | Unknown, missing or broken child Space |
| `MODE_UNAVAILABLE` | The command needs the headless runtime, which this build does not include |
| `INVALID_SOURCE_ENCODING` | `page read`: the source is not UTF-8 |

## Help and version

`svode --help`, `svode <noun> --help`, `svode <noun> <verb> --help` and `svode --version` work without a Project, and every help page names a working example. Mutating commands describe the safe read → edit → write cycle and recovery; commands that need the headless runtime say so.

## Installation

The desktop app bundle ships the `svode` binary of the same version as a sidecar next to its own executable (Linux packages place sidecars in `/usr/bin`). Managed `PATH` setup, installation without the desktop app and updates are not part of this build.
