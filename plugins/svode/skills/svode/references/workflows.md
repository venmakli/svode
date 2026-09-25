# Svode workflows

## Target

- Work inside the project directory: `svode` picks the nearest project that contains the current directory and the most specific child Space that contains it, otherwise `root`.
- Elsewhere pass `--project <path>`, and `--space root` or `--space <child id>` from `svode space list`.
- In MCP pass `spaceId: "root"` or a child id from `list_spaces`. Routine tools always need an explicit `spaceId`.
- Continue with the canonical paths a result returns (`path`, `newPath`, `contentPath`, `collectionPath`), not with the path you sent.

## Change text, then fields

1. Read the file, or `svode item read --path <item> --json` for its fields.
2. Edit the body below the frontmatter with your own tools.
3. Change fields, title or relations through Svode, for example `svode item fields set --path <item> --fields-file fields.json`.
4. Schema changes start from `svode collection schema --collection <path> --json`.

Svode sees your direct edit on its next read; the desktop app reloads it or, when the Page has unsaved text, offers recovery.

## Structure

Create Pages, Collection items and Collections with `svode page create` and `svode collection create`; move, rename, reorder and convert with `svode content …`. After structural files changed outside Svode, run `svode collection check` and repair what it reports.

## Review

Every mutation returns `changedPaths` and never commits. Show the user what changed (`git status`, `git diff`) and commit only on request.

## Recovery

A failure has a stable `error.code`, a target and often a `hint`; exit code 1 is an operation failure, 2 a wrong command line.

- `PROJECT_UNAVAILABLE`, `SPACE_UNAVAILABLE`: run inside the project or pass `--project`/`--space`.
- `REPOSITORY_ACCESS_DENIED`: nothing was written; run `svode git access verify` for that Space, then retry.
- `SOURCE_STALE`: the file changed after your read; read it again and reapply the change. `SOURCE_BUSY`: another Svode operation is writing; retry later.
- `PAGE_NAME_CONFLICT`, `ROUTINE_FINGERPRINT_CONFLICT`: read the current state from the error and decide again; do not resend blindly.
- A result with warnings was applied; do not repeat it.
- `svode doctor` diagnoses the project, Spaces, Git and runtime without changing anything.
