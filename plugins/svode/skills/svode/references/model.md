# Svode model

- **Project**: a directory whose `.svode/config.json` makes it the root Space. Its Git repository holds the content; device-local state in `.svode/` is not content.
- **Space**: the root Space (`root`) or a registered child Space with its own id, directory and possibly its own repository. `svode space list` shows them; the MCP tool is `list_spaces`.
- **Page**: a standalone `.md` file (leaf Page) or a directory with `README.md` (directory-backed Page) that owns subpages and files. Frontmatter holds system metadata: title, icon, description, cover, created, updated.
- **Collection**: a directory with `README.md` (its identity and description) and `schema.yaml` (columns, views, templates). Each item is a `.md` file inside it; custom fields live in the item frontmatter, typed by the schema.
- **Fields**: text, number, select, status, actor (canonical emails), date, boolean, relation, unique id and others. A relation value is the path of an item inside the target Collection; two-way relations write both sides, which is why fields change only through Svode.
- **Views**: table, board, calendar, list and gallery definitions in `schema.yaml`.
- **Attachments**: files copied next to the Page or item that owns them by an import; use the returned link as is.
- **Routines**: agent tasks defined per Space or Collection owner under `.routines/`, edited only through the Routine commands with the fingerprint of the last read. Starting one is `run_routine` of the desktop app.
- **Apps**: a directory with `app.yaml`; validate a candidate with `svode app validate` before writing it.
- **Index**: search, Collection queries and Knowledge come from an index that Svode brings up to date before answering; `INDEX_UNAVAILABLE` is an error, not an empty result.
