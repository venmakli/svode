---
name: svode
description: Read and change Svode projects, which keep Pages, Collections of items with fields and relations, Spaces, Routine definitions and Apps as Markdown and YAML files in Git. Use when the task touches a directory tree with .svode/config.json, a Svode Page, Collection, item, field, relation, schema, view, attachment, Routine or App, when the user asks to start a Svode project or add a Space, or when the user mentions Svode.
---

# Svode

A Svode project is a Git repository of Markdown and YAML files: its root holds `.svode/config.json`. Content lives in Spaces (the root Space and optional child Spaces), as Pages and as Collections whose items carry fields in frontmatter. The model is in [references/model.md](references/model.md); targeting, the mixed file-and-Svode workflow, review and recovery are in [references/workflows.md](references/workflows.md).

## Pick the interface

1. **The `svode` CLI first.** With a shell, run `svode`: it finds the project and Space from the current directory, prints one JSON object with `--json` and costs nothing until you call it. If `svode` is not on PATH, run it by its full path `~/.svode/bin/svode`.
2. **The Svode MCP server `svode`** when you have no shell, when the task is about what is open in the Svode desktop window, to start a Routine or to run a process App: `run_routine`, `get_app_status` and `control_app` work only while the Svode desktop app runs.

Both run the same operations with the same results and codes; finish one change through one of them.

## Rules of the installed version

Run `svode guide` once before the first change in a session (in MCP: `get_svode_guide`). It prints the rules of the Svode version you run: structure choice, creating projects and Spaces, Space targeting, fields, schema, attachments, Routines and Apps. Its operation names are MCP tool names; the matching command is under `svode --help`, and `svode <noun> [<verb>] --help` gives exact flags with an example. Trust the guide and help over memory or this skill.

## Files first

- Read files and search text with your own tools. Use `svode search`, `svode collection query` and `svode knowledge` for questions the Svode index answers.
- Change the text below the frontmatter of an existing Page, Collection item or README with your own editing tools. Keep the frontmatter byte for byte, the line endings and the file location. A new plain Page in an existing folder without `schema.yaml` can be created as a file.
- Everything else goes through Svode, because Svode applies effects a raw edit misses: frontmatter (title, icon, description, cover, fields, relations), new Collection items and Pages under a leaf Page, rename (by title for a Page, item or Collection), move, delete, convert and order, `schema.yaml` and views, attachments, Routine definitions and the `.svode/`, `.routines/` and `.templates/` folders.
- With file access do not rewrite a body through Svode: the body-write commands and tools serve clients without file access.

## Projects and Spaces

Start a project with `svode project create <path>` and add a Space with `svode space create <folder> --name <name>` (MCP: `create_project`, `create_space`); never write `.svode/` yourself. Read the guide before you choose between a project and a Space or pick the Git type of a Space.

## Apps

- An App is a directory with `app.yaml` that the Svode desktop app opens as a window. When a task touches an App's data or code, find it with `svode app list` and read its description with `svode app show <owner>` (MCP: `list_apps`, `get_app`): it carries the App's README, where its author says how an agent works with it.
- The state, logs, start, restart and stop of a process App are the MCP tools `get_app_status` and `control_app`, served only while the Svode desktop app has the project open.
- When you create an App, describe in its README how an agent works with it.
- How an App page follows the light or dark Svode theme is in the guide.
- A tool with its own agent integration is set up its own way; Svode does not install or register it. The details are in the guide.

## After a change

Svode commands and tools never commit. Check the `changedPaths` of every result and `git status`; the Git rules below decide what you may do next.

## Git in a Svode project

- These rules apply in the repositories of the Svode project: its root and its Spaces. In a nested repository that is not a Space, for example a code clone in a folder that the root `.gitignore` excludes, work by the rules of that repository: branches, commits, push and PRs there are ordinary work.
- The Svode app commits and syncs the project. Without an explicit request from the user in the current conversation, do not run `git commit`, `commit --amend`, `push`, `pull`, `merge`, `rebase`, `reset`, `stash`, `clean`, or `checkout` or `switch` of branches.
- When the user asks for Git work: integrate with merge, not rebase; never force-push or rewrite published history; never skip hooks (`--no-verify`); never change Git config; do not delete branches or tags unless asked; add files by explicit paths.
- For a conflict or Git operation that Svode handed over: change only the listed files; keep what each side added unless the user decided otherwise; keep JSON, YAML and frontmatter valid and free of conflict markers; finish a merge with a commit that adds the resolved files by explicit paths and nothing else; continue or abort another operation as the user asked; do not publish: Svode pushes.
- Do not edit `.svode/order.json` or the pointers of child Spaces to resolve a conflict: Svode merges them. Change structure through Svode tools or `svode` commands.
