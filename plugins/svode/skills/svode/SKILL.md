---
name: svode
description: Read and change Svode projects, which keep Pages, Collections of items with fields and relations, Spaces and Routine definitions as Markdown and YAML files in Git. Use when the task touches a directory tree with .svode/config.json, a Svode Page, Collection, item, field, relation, schema, view, attachment or Routine, or when the user mentions Svode.
---

# Svode

A Svode project is a Git repository of Markdown and YAML files: its root holds `.svode/config.json`. Content lives in Spaces (the root Space and optional child Spaces), as Pages and as Collections whose items carry fields in frontmatter. The model is in [references/model.md](references/model.md); targeting, the mixed file-and-Svode workflow, review and recovery are in [references/workflows.md](references/workflows.md).

## Pick the interface

1. **The `svode` CLI first.** With a shell, run `svode`: it finds the project and Space from the current directory, prints one JSON object with `--json` and costs nothing until you call it. If `svode` is not on PATH, run it by its full path `~/.svode/bin/svode`.
2. **The Svode MCP server `svode`** when you have no shell, when the task is about what is open in the Svode desktop window, or to start a Routine: `run_routine` works only while the Svode desktop app runs.

Both run the same operations with the same results and codes; finish one change through one of them.

## Rules of the installed version

Run `svode guide` once before the first change in a session (in MCP: `get_svode_guide`). It prints the rules of the Svode version you run: structure choice, Space targeting, fields, schema, attachments, Routines and Apps. Its operation names are MCP tool names; the matching command is under `svode --help`, and `svode <noun> [<verb>] --help` gives exact flags with an example. Trust the guide and help over memory or this skill.

## Files first

- Read files and search text with your own tools. Use `svode search`, `svode collection query` and `svode knowledge` for questions the Svode index answers.
- Change the text below the frontmatter of an existing Page, Collection item or README with your own editing tools. Keep the frontmatter byte for byte, the line endings and the file location. A new plain Page in an existing folder without `schema.yaml` can be created as a file.
- Everything else goes through Svode, because Svode applies effects a raw edit misses: frontmatter (title, icon, description, cover, fields, relations), new Collection items and Pages under a leaf Page, rename, move, delete, convert and order, `schema.yaml` and views, attachments, Routine definitions and the `.svode/`, `.routines/` and `.templates/` folders.
- With file access do not rewrite a body through Svode: the body-write commands and tools serve clients without file access.

## After a change

Svode never commits. Check the `changedPaths` of every result and `git status`; commit only when the user asks.
