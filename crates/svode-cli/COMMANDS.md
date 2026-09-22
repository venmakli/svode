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

This build runs standalone reads answered from project sources. Commands that need the index, the Git runtime or the Actor catalog of the headless runtime answer `MODE_UNAVAILABLE` (exit 1) and run nothing; `svode doctor` lists the served capabilities.

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
| `guide` | `get_svode_guide` plus files-first rules | yes, without a Project |
| `doctor` | CLI diagnostics | yes, target failures are part of the result |

Flags follow the tool arguments: `collectionPath → --collection`, `path → --path`, `nodeId → --id`, `nodeKinds → --kind`, `edgeKinds → --edge-kind`, camelCase → kebab-case. Repeated flags keep their order. `--scope` is `space` (default) or `project`.

## Structured input

Filter and sort of `collection query` are JSON arrays of the shared query shape, read with `--filter-file <path|->` and `--sort-file <path|->`. A relative path is read from the current directory, `-` reads stdin, and a command reads stdin at most once. Unreadable input is `INPUT_UNREADABLE`, invalid JSON or two `-` are `INVALID_ARGUMENT`; both exit 2 before the command runs.

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
| `INPUT_UNREADABLE` | An input file or stdin cannot be read (exit 2) |
| `PROJECT_UNAVAILABLE` | The Project directory or `.svode/config.json` is missing or unreadable, or no Project contains the current directory |
| `INVALID_PROJECT_CONFIG` | `.svode/config.json` is not a valid Project config |
| `SPACE_UNAVAILABLE` | Unknown, missing or broken child Space |
| `MODE_UNAVAILABLE` | The command needs the headless runtime, which this build does not include |
| `INVALID_SOURCE_ENCODING` | `page read`: the source is not UTF-8 |

## Help and version

`svode --help`, `svode <noun> --help`, `svode <noun> <verb> --help` and `svode --version` work without a Project and name a working example.
