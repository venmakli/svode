//! Every public `svode` command with a runnable argument list and the
//! catalog tools it maps to, a fixture those arguments address, and the
//! command tree of the grammar.

use std::path::PathBuf;

use clap::CommandFactory;
use svode_cli::grammar::Cli;

use super::process::write;

/// One runnable invocation of a public command.
pub struct Case {
    /// Command path as the grammar names it, e.g. `collection column add`.
    pub name: &'static str,
    /// Arguments after the global selectors; relative input files are read
    /// from the fixture input directory.
    pub argv: &'static [&'static str],
    /// Catalog tools the invocation asks the host for; empty for the
    /// CLI-owned diagnostics `doctor` and `git access verify`. Body writes pass a `sourceVersion` of no read,
    /// so a served write is refused as stale before any effect.
    pub tools: &'static [&'static str],
}

const fn case(
    name: &'static str,
    argv: &'static [&'static str],
    tools: &'static [&'static str],
) -> Case {
    Case { name, argv, tools }
}

/// `--source-version` of no read of the addressed source.
pub const STALE: &str = "stale-source-version";

pub const CASES: &[Case] = &[
    case("project info", &["project", "info"], &["get_project_info"]),
    case("space list", &["space", "list"], &["list_spaces"]),
    case(
        "space readme read",
        &["space", "readme", "read"],
        &["read_space_readme"],
    ),
    case(
        "space readme write",
        &[
            "space",
            "readme",
            "write",
            "--body-file",
            "body.md",
            "--source-version",
            STALE,
        ],
        &["write_space_readme"],
    ),
    case(
        "space meta set",
        &["space", "meta", "set", "--icon", "📝"],
        &["update_space_metadata"],
    ),
    case(
        "space reorder",
        &["space", "reorder", "--id", "wiki", "--id", "child"],
        &["reorder_spaces"],
    ),
    case("page list", &["page", "list"], &["list_pages"]),
    case(
        "page read",
        &["page", "read", "--path", "notes.md"],
        &["read_page"],
    ),
    case(
        "page create",
        &[
            "page",
            "create",
            "--parent",
            "",
            "--title",
            "New",
            "--body-file",
            "body.md",
            "--cover-file",
            "cover.json",
        ],
        &["create_page"],
    ),
    case(
        "page write",
        &[
            "page",
            "write",
            "--path",
            "notes.md",
            "--body-file",
            "body.md",
            "--source-version",
            STALE,
        ],
        &["write_page"],
    ),
    case(
        "page meta set",
        &["page", "meta", "set", "--path", "notes.md", "--clear-icon"],
        &["update_page_metadata"],
    ),
    case(
        "page delete",
        &["page", "delete", "--path", "notes.md"],
        &["delete_page"],
    ),
    case(
        "collection list",
        &["collection", "list"],
        &["list_collections"],
    ),
    case(
        "collection schema",
        &["collection", "schema", "--collection", "tasks"],
        &["get_collection_schema"],
    ),
    case(
        "collection query",
        &[
            "collection",
            "query",
            "--collection",
            "tasks",
            "--filter-file",
            "filter.json",
            "--sort-file",
            "sort.json",
            "--limit",
            "10",
        ],
        &["query_collection_items"],
    ),
    case(
        "collection readme read",
        &["collection", "readme", "read", "--collection", "tasks"],
        &["read_collection_readme"],
    ),
    case(
        "collection readme write",
        &[
            "collection",
            "readme",
            "write",
            "--collection",
            "tasks",
            "--body",
            "Tasks",
            "--source-version",
            STALE,
        ],
        &["write_collection_readme"],
    ),
    case(
        "collection meta set",
        &[
            "collection",
            "meta",
            "set",
            "--collection",
            "tasks",
            "--description",
            "Work",
        ],
        &["update_collection_metadata"],
    ),
    case(
        "collection create",
        &[
            "collection",
            "create",
            "--parent",
            "",
            "--title",
            "Board",
            "--columns-file",
            "columns.json",
            "--views-file",
            "views.json",
        ],
        &["create_collection"],
    ),
    case(
        "collection delete",
        &["collection", "delete", "--collection", "tasks"],
        &["delete_collection"],
    ),
    case(
        "collection check",
        &["collection", "check", "--collection", "tasks"],
        &["validate_collection_integrity"],
    ),
    case(
        "collection column add",
        &[
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            "column.json",
        ],
        &["add_collection_column"],
    ),
    case(
        "collection column update",
        &[
            "collection",
            "column",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Status",
            "--patch-file",
            "patch.json",
        ],
        &["update_collection_column"],
    ),
    case(
        "collection column delete",
        &[
            "collection",
            "column",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Status",
            "--delete-values",
        ],
        &["delete_collection_column"],
    ),
    case(
        "collection view add",
        &[
            "collection",
            "view",
            "add",
            "--collection",
            "tasks",
            "--view-file",
            "view.json",
            "--position",
            "0",
        ],
        &["add_collection_view"],
    ),
    case(
        "collection view update",
        &[
            "collection",
            "view",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Table",
            "--patch-file",
            "patch.json",
        ],
        &["update_collection_view"],
    ),
    case(
        "collection view delete",
        &[
            "collection",
            "view",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Table",
        ],
        &["delete_collection_view"],
    ),
    case(
        "item read",
        &["item", "read", "--path", "tasks/alpha.md"],
        &["read_collection_item"],
    ),
    case(
        "item write",
        &[
            "item",
            "write",
            "--path",
            "tasks/alpha.md",
            "--body-file",
            "body.md",
            "--source-version",
            STALE,
        ],
        &["update_collection_item_body"],
    ),
    case(
        "item fields set",
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            "fields.json",
        ],
        &["update_collection_item_fields"],
    ),
    case(
        "item meta set",
        &[
            "item",
            "meta",
            "set",
            "--path",
            "tasks/alpha.md",
            "--title",
            "Beta",
        ],
        &["update_collection_item_metadata"],
    ),
    case(
        "item delete",
        &["item", "delete", "--path", "tasks/alpha.md"],
        &["delete_collection_item"],
    ),
    case(
        "content rename",
        &["content", "rename", "--path", "notes.md", "--to", "Plan.md"],
        &["rename_content"],
    ),
    case(
        "content move",
        &[
            "content",
            "move",
            "--path",
            "notes.md",
            "--to-parent",
            "folder",
        ],
        &["move_content"],
    ),
    case(
        "content reorder",
        &[
            "content",
            "reorder",
            "--parent",
            "list",
            "--child",
            "list/b.md",
            "--child",
            "list/a.md",
        ],
        &["reorder_content"],
    ),
    case(
        "content convert",
        &[
            "content",
            "convert",
            "--path",
            "folder/README.md",
            "--to",
            "leaf",
        ],
        &["convert_page_to_leaf"],
    ),
    case(
        "content convert",
        &[
            "content",
            "convert",
            "--path",
            "notes.md",
            "--to",
            "collection",
        ],
        &["convert_to_collection"],
    ),
    case(
        "actor list",
        &["actor", "list", "--all-time"],
        &["list_actors"],
    ),
    case(
        "search",
        &["search", "notes", "--limit", "5", "--offset", "0"],
        &["search_pages"],
    ),
    case(
        "knowledge search",
        &[
            "knowledge",
            "search",
            "notes",
            "--kind",
            "page",
            "--limit",
            "5",
        ],
        &["search_knowledge"],
    ),
    case(
        "knowledge node",
        &["knowledge", "node", "--id", "page:root:notes.md"],
        &["get_knowledge_node"],
    ),
    case(
        "knowledge neighbors",
        &[
            "knowledge",
            "neighbors",
            "--id",
            "page:root:notes.md",
            "--edge-kind",
            "links_to",
        ],
        &["get_knowledge_neighbors"],
    ),
    case(
        "knowledge context",
        &["knowledge", "context", "notes", "--text-budget", "500"],
        &["get_related_context"],
    ),
    case(
        "knowledge status",
        &["knowledge", "status", "--scope", "project"],
        &["get_knowledge_status"],
    ),
    case("git status", &["git", "status"], &["get_git_status"]),
    case("git access verify", &["git", "access", "verify"], &[]),
    case(
        "asset import",
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            "chart.png",
        ],
        &["import_asset"],
    ),
    case(
        "app validate",
        &["app", "validate", "--file", "app.yaml"],
        &["validate_app_manifest"],
    ),
    case("routine list", &["routine", "list"], &["list_routines"]),
    case(
        "routine get",
        &["routine", "get", "--id", ROUTINE_ID],
        &["get_routine"],
    ),
    case(
        "routine create",
        &["routine", "create", "--definition-file", "routine.json"],
        &["create_routine"],
    ),
    case(
        "routine update",
        &[
            "routine",
            "update",
            "--id",
            ROUTINE_ID,
            "--fingerprint",
            "0",
            "--definition-file",
            "routine.json",
        ],
        &["update_routine"],
    ),
    case(
        "routine delete",
        &[
            "routine",
            "delete",
            "--collection",
            "tasks",
            "--id",
            ROUTINE_ID,
            "--fingerprint",
            "0",
        ],
        &["delete_routine"],
    ),
    case("guide", &["guide"], &["get_svode_guide"]),
    case("doctor", &["doctor"], &[]),
];

const ROUTINE_ID: &str = "routine:01arz3ndektsv4rrffq69g5fav";

/// Project with a root Space, a registered child Space, a Page, a
/// directory-backed Page and a Collection with one item, plus an input
/// directory outside the Project with every file the cases read.
pub struct Fixture {
    pub temp: tempfile::TempDir,
    pub project: PathBuf,
    pub input: PathBuf,
}

pub fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let project = base.join("project");
    let input = base.join("input");
    write(
        &project.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null},{"id":"wiki","path":"wiki","repo":null}]}"#,
    );
    write(
        &project.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(
        &project.join("wiki/.svode/config.json"),
        r#"{"name":"Wiki"}"#,
    );
    write(
        &project.join("README.md"),
        "---\ntitle: Project\n---\nRoot\n",
    );
    write(
        &project.join("notes.md"),
        "---\ntitle: Notes\nicon: 🗒\n---\nNotes body\n",
    );
    write(
        &project.join("folder/README.md"),
        "---\ntitle: Folder\n---\nFolder body\n",
    );
    write(&project.join("list/README.md"), "---\ntitle: List\n---\n");
    write(&project.join("list/a.md"), "---\ntitle: A\n---\n");
    write(&project.join("list/b.md"), "---\ntitle: B\n---\n");
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&project.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    write(&input.join("body.md"), "New body\n");
    write(
        &input.join("cover.json"),
        r#"{"type":"color","value":"blue"}"#,
    );
    write(&input.join("fields.json"), r#"{"Status":"Done"}"#);
    write(&input.join("filter.json"), "[]");
    write(&input.join("sort.json"), "[]");
    write(
        &input.join("columns.json"),
        r#"[{"name":"Owner","type":"text"}]"#,
    );
    write(
        &input.join("views.json"),
        r#"[{"type":"table","name":"All"}]"#,
    );
    write(
        &input.join("column.json"),
        r#"{"name":"Stage","type":"text"}"#,
    );
    write(
        &input.join("view.json"),
        r#"{"type":"table","name":"Board"}"#,
    );
    write(&input.join("patch.json"), r#"{"name":"Renamed"}"#);
    write(&input.join("chart.png"), "not really a png");
    write(
        &input.join("app.yaml"),
        "runtime:\n  type: process\n  start:\n    argv: [tool]\n  url: http://127.0.0.1:3210\n",
    );
    write(
        &input.join("routine.json"),
        r#"{"name":"Review","trigger":{"type":"manual"},"action":{"type":"run_agent","executor":"agent:01arz3ndektsv4rrffq69g5fav"},"body":"Review."}"#,
    );
    // Git history for the Actor catalog and Git status; reads never change it.
    for args in [
        &["init", "-q"][..],
        &["config", "user.email", "agent@example.com"],
        &["config", "user.name", "Agent"],
        &["add", "-A"],
        &["commit", "-q", "-m", "fixture"],
    ] {
        let _ = std::process::Command::new("git")
            .args(args)
            .current_dir(&project)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output();
    }
    Fixture {
        temp,
        project,
        input,
    }
}

/// Arguments of a case addressed to the fixture Project.
pub fn argv<'a>(fixture: &'a Fixture, case: &'a Case) -> Vec<&'a str> {
    let mut args = vec!["--project", fixture.project.to_str().unwrap()];
    args.extend_from_slice(case.argv);
    args
}

/// Every command path of the grammar: nouns, verb groups and leaf
/// commands, without clap's generated `help`.
pub fn command_paths() -> Vec<(String, bool)> {
    fn walk(command: &clap::Command, prefix: &str, paths: &mut Vec<(String, bool)>) {
        for sub in command.get_subcommands() {
            if sub.get_name() == "help" {
                continue;
            }
            let path = if prefix.is_empty() {
                sub.get_name().to_string()
            } else {
                format!("{prefix} {}", sub.get_name())
            };
            let leaf = !sub.get_subcommands().any(|sub| sub.get_name() != "help");
            paths.push((path.clone(), leaf));
            walk(sub, &path, paths);
        }
    }
    let mut paths = Vec::new();
    walk(&Cli::command(), "", &mut paths);
    paths
}

/// Leaf commands of the grammar.
pub fn leaf_commands() -> Vec<String> {
    command_paths()
        .into_iter()
        .filter_map(|(path, leaf)| leaf.then_some(path))
        .collect()
}
