# svode command reference

`svode [--project <path>] [--space <root|space-id>] [--json] <noun> <verb> [--flags]`

Global selectors may appear before or after the command. `--project` is absolute or relative to the current directory; `--space` is `root` for the Project Space or a registered child Space id. The active desktop window, recent projects and the environment never select the target.

## Output and exit codes

- stdout carries only the result; warnings, diagnostics and usage go to stderr.
- With `--json`, stdout holds exactly one JSON object. Success: `{"schemaVersion":1,"ok":true,"target":{…},…result}`. Failure: `{"schemaVersion":1,"ok":false,"error":{"code":"…","message":"…","target":{…}}}`; `target` holds only the selectors known at the moment of failure.
- Exit `0` — success (including warnings); `1` — operation failure; `2` — grammar or input failure (`INVALID_ARGUMENT`).

## page read

`svode --project <path> page read --space <root|space-id> --path <relative.md> [--json]`

Reads one standalone Page from its Markdown source, without the desktop app, the index or Routine stores. `--project`, `--space` and `--path` are required. `--path` is relative to the selected Space; a directory-backed Page is read through its `README.md`.

Human output prints the scoped Page path, a blank line and the body. JSON output:

```json
{ "schemaVersion": 1, "ok": true,
  "target": { "projectPath": "…", "spaceId": "root", "spacePath": "…", "path": "notes/today.md" },
  "page": { "meta": { "title": "…", "created": "…", "updated": "…", … }, "body": "…", "path": "notes/today.md" },
  "sourceVersion": "…" }
```

`page` has the same shape as the MCP `read_page` result. `sourceVersion` is an opaque token of the exact bytes read; store it whole. Malformed frontmatter is a successful read with a `malformed_frontmatter` warning, and the source is never rewritten.

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | Unknown command/flag or a missing selector (exit 2) |
| `PROJECT_UNAVAILABLE` | Project directory or `.svode/config.json` is missing or unreadable |
| `INVALID_PROJECT_CONFIG` | `.svode/config.json` is not a valid Project config |
| `SPACE_UNAVAILABLE` | Unknown, missing or broken child Space |
| `INVALID_PATH` | Empty, absolute, `..`, non-Markdown or non-file path |
| `PATH_FORBIDDEN` | `.git/**`, `.svode/**` or a symlink escaping the Space |
| `NOT_A_STANDALONE_PAGE` | Owner README, Collection item, agent context file or child Space content |
| `FILE_NOT_FOUND` | The Markdown source does not exist |
| `INVALID_SOURCE_ENCODING` | The source is not UTF-8 |
| `PATH_NOT_ACCESSIBLE` | Permission denied |
| `IO_ERROR` | Other I/O failure |

Example:

```sh
svode --project ~/Notes page read --space root --path notes/today.md --json
```

## Other commands

`svode --help`, `svode <noun> --help`, `svode <noun> <verb> --help` and `svode --version` work without a Project.
