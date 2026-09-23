//! Metadata, field, schema column and view changes through real `svode`
//! processes with the desktop app closed: the shared operation with its
//! rename, reverse relation and rollback outcomes, the `sourceVersion` of
//! the resulting source, authorization of every repository of the change
//! before its first write with a typed refusal, busy refusals, publication
//! into the index of the changed Space, and the Routine event of a field
//! change recorded for the desktop app without the edits other programs
//! made meanwhile.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use common::process::{BIN, TEST_IDENTIFIER, code, json, snapshot, write};
use serde_json::{Value, json};

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn commit(root: &Path) {
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "agent@example.com"]);
    git(root, &["config", "user.name", "Agent"]);
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "fixture"]);
}

fn head(root: &Path) -> String {
    String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
}

/// Committed project: a Page, a Collection with a two-way relation to
/// another Collection, and the input files of the commands.
fn fixture() -> Option<(tempfile::TempDir, PathBuf)> {
    if !has_git() {
        return None;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\nOwner\n");
    write(
        &root.join("notes/today.md"),
        "---\ntitle: Today\n---\nToday body\n",
    );
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - { name: Status, type: text }\n  - { name: Estimate, type: number }\n  - name: Person\n    type: relation\n    relation: people\n    limit: one\n    two_way: Tasks\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\nEstimate: 3\n---\nAlpha body\n",
    );
    write(
        &root.join("people/schema.yaml"),
        "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    two_way: Person\nviews: []\n",
    );
    write(&root.join("people/README.md"), "---\ntitle: People\n---\n");
    write(
        &root.join("people/Ada.md"),
        "---\ntitle: Ada\n---\nPerson\n",
    );
    commit(&root);
    Some((temp, root))
}

fn input(root: &Path, name: &str, text: &str) -> String {
    let path = root.parent().unwrap().join("input").join(name);
    write(&path, text);
    path.to_string_lossy().to_string()
}

fn ok(root: &Path, args: &[&str]) -> Value {
    let (exit, value) = json(root, args, None);
    assert_eq!(exit, 0, "{args:?}: {value}");
    assert_eq!(value["ok"], true, "{args:?}");
    value
}

fn source(root: &Path, path: &str) -> String {
    std::fs::read_to_string(root.join(path)).unwrap()
}

fn read_version(root: &Path, args: &[&str]) -> String {
    ok(root, args)["sourceVersion"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn metadata_field_schema_and_view_commands_apply_the_shared_operation() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    let before = head(root);

    // Page metadata: a patch keeps the body; a title renames by the shared
    // naming rules; the result carries the version of the resulting source.
    let changed = ok(
        root,
        &[
            "page",
            "meta",
            "set",
            "--path",
            "notes/today.md",
            "--icon",
            "📝",
            "--description",
            "Daily",
        ],
    );
    assert_eq!(changed["changedPaths"], json!(["notes/today.md"]));
    assert_eq!(changed["page"]["meta"]["icon"], "📝");
    assert_eq!(
        changed["sourceVersion"],
        read_version(root, &["page", "read", "--path", "notes/today.md"]).as_str()
    );
    assert!(source(root, "notes/today.md").ends_with("Today body\n"));
    let renamed = ok(
        root,
        &[
            "page",
            "meta",
            "set",
            "--path",
            "notes/today.md",
            "--title",
            "Plan",
            "--clear-description",
        ],
    );
    assert_eq!(renamed["page"]["path"], "notes/Plan.md");
    assert!(!root.join("notes/today.md").exists());
    assert!(source(root, "notes/Plan.md").contains("icon: 📝"));
    assert!(!source(root, "notes/Plan.md").contains("Daily"));

    // Owner metadata of the Space and the Collection README.
    let space = ok(root, &["space", "meta", "set", "--description", "Root"]);
    assert_eq!(space["spaceReadme"]["meta"]["description"], "Root");
    assert!(space["sourceVersion"].is_string());
    let owner = ok(
        root,
        &[
            "collection",
            "meta",
            "set",
            "--collection",
            "tasks",
            "--icon",
            "✅",
        ],
    );
    assert_eq!(owner["collectionPath"], "tasks");
    assert_eq!(owner["collectionReadme"]["meta"]["icon"], "✅");

    // Item fields: one batch with a two-way relation writes the reverse
    // value into the related item.
    let fields = input(
        root,
        "fields.json",
        r#"{"Status":"Done","Person":"Ada.md"}"#,
    );
    let item = ok(
        root,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &fields,
        ],
    );
    let mut paths = item["changedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    paths.sort();
    assert!(paths.contains(&"tasks/alpha.md".to_string()), "{paths:?}");
    assert!(
        paths.iter().any(|path| path.ends_with("people/Ada.md")),
        "{paths:?}"
    );
    assert!(source(root, "tasks/alpha.md").contains("Status: Done"));
    assert!(source(root, "people/Ada.md").contains("alpha.md"));
    assert_eq!(
        item["sourceVersion"],
        read_version(root, &["item", "read", "--path", "tasks/alpha.md"]).as_str()
    );
    // An empty batch reads without writing.
    let empty = input(root, "empty.json", "{}");
    let read = ok(
        root,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &empty,
        ],
    );
    assert_eq!(read["changedPaths"], json!([]));

    // Item metadata: a title renames the item and updates the reverse
    // relation value in the related item.
    let item = ok(
        root,
        &[
            "item",
            "meta",
            "set",
            "--path",
            "tasks/alpha.md",
            "--title",
            "Beta",
        ],
    );
    assert_eq!(item["item"]["path"], "tasks/Beta.md");
    assert!(source(root, "people/Ada.md").contains("Beta.md"));

    // Schema columns and views; the result is the normalized schema.
    let column = input(root, "column.json", r#"{"name":"Stage","type":"text"}"#);
    let added = ok(
        root,
        &[
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            &column,
        ],
    );
    assert_eq!(added["changedPaths"], json!(["tasks/schema.yaml"]));
    assert!(
        added["schema"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|column| column["name"] == "Stage")
    );
    // Dropping the two-way side of a relation also rewrites the schema of
    // the related Collection.
    let patch = input(root, "patch.json", r#"{"two_way":null}"#);
    let detached = ok(
        root,
        &[
            "collection",
            "column",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Person",
            "--patch-file",
            &patch,
        ],
    );
    let changed = detached["changedPaths"].as_array().unwrap();
    assert!(changed.contains(&json!("tasks/schema.yaml")), "{detached}");
    assert!(
        changed
            .iter()
            .any(|path| path.as_str().unwrap().ends_with("people/schema.yaml")),
        "{detached}"
    );
    assert!(!source(root, "people/schema.yaml").contains("two_way"));
    let deleted = ok(
        root,
        &[
            "collection",
            "column",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Estimate",
            "--delete-values",
        ],
    );
    assert!(!source(root, "tasks/Beta.md").contains("Estimate"));
    assert!(
        !deleted["schema"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|column| column["name"] == "Estimate")
    );
    let view = input(root, "view.json", r#"{"type":"table","name":"Board"}"#);
    ok(
        root,
        &[
            "collection",
            "view",
            "add",
            "--collection",
            "tasks",
            "--view-file",
            &view,
            "--position",
            "0",
        ],
    );
    let view_patch = input(root, "view-patch.json", r#"{"name":"All"}"#);
    ok(
        root,
        &[
            "collection",
            "view",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Table",
            "--patch-file",
            &view_patch,
        ],
    );
    let views = ok(
        root,
        &[
            "collection",
            "view",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Board",
        ],
    );
    assert_eq!(views["schema"]["views"][0]["name"], "All");
    assert_eq!(views["schema"]["views"].as_array().unwrap().len(), 1);

    // The schema change is visible to the next index-backed read.
    let filter = input(
        root,
        "filter.json",
        r#"[{"field":"Status","op":"eq","value":"Done"}]"#,
    );
    let query = ok(
        root,
        &[
            "collection",
            "query",
            "--collection",
            "tasks",
            "--filter-file",
            &filter,
        ],
    );
    assert_eq!(query["items"][0]["path"], "tasks/Beta.md", "{query}");

    // Nothing was committed.
    assert_eq!(head(root), before);
}

#[test]
fn a_rejected_change_writes_nothing() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    let before = snapshot(root);
    let late = input(
        root,
        "late.json",
        r#"{"Status":"Done","Person":"Ada.md","created":"2020-01-01"}"#,
    );
    let duplicate = input(root, "duplicate.json", r#"{"name":"Status","type":"text"}"#);
    let long = "x".repeat(501);
    for args in [
        // A read-only field fails the whole batch before any value or the
        // reverse relation is written.
        vec![
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &late,
        ],
        // An invalid description fails the whole patch, title included.
        vec![
            "page",
            "meta",
            "set",
            "--path",
            "notes/today.md",
            "--title",
            "Plan",
            "--description",
            &long,
        ],
        vec![
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            &duplicate,
        ],
        vec![
            "collection",
            "view",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Missing",
        ],
        vec![
            "item",
            "meta",
            "set",
            "--path",
            "notes/today.md",
            "--icon",
            "x",
        ],
    ] {
        let (exit, value) = json(root, &args, None);
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(value["ok"], false, "{args:?}");
    }
    let mut after = snapshot(root);
    // Derived stores of the index checks are not sources.
    after.retain(|path, _| !path.starts_with(".svode") || path.ends_with("config.json"));
    let mut expected = before;
    expected.retain(|path, _| !path.starts_with(".svode") || path.ends_with("config.json"));
    assert_eq!(after, expected);
}

#[test]
fn every_repository_of_the_change_is_authorized_before_the_first_write() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    git(
        root,
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/never.git",
        ],
    );
    let fields = input(root, "fields.json", r#"{"Status":"Done"}"#);
    let column = input(root, "column.json", r#"{"name":"Stage","type":"text"}"#);
    let before = snapshot(root);
    for args in [
        vec![
            "page",
            "meta",
            "set",
            "--path",
            "notes/today.md",
            "--icon",
            "x",
        ],
        vec!["space", "meta", "set", "--description", "Root"],
        vec![
            "collection",
            "meta",
            "set",
            "--collection",
            "tasks",
            "--icon",
            "x",
        ],
        vec![
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &fields,
        ],
        vec![
            "item",
            "meta",
            "set",
            "--path",
            "tasks/alpha.md",
            "--icon",
            "x",
        ],
        vec![
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            &column,
        ],
        vec![
            "collection",
            "view",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Table",
        ],
    ] {
        let (exit, value) = json(root, &args, None);
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(code(&value), "REPOSITORY_ACCESS_DENIED", "{args:?}");
        let error = &value["error"];
        assert_eq!(error["status"], "unknown", "{error}");
        assert_eq!(error["reason"], "not_checked", "{error}");
        assert!(error["repositoryId"].is_string(), "{error}");
        assert!(
            error["hint"]
                .as_str()
                .unwrap()
                .contains("svode git access verify"),
            "{error}"
        );
    }
    assert_eq!(snapshot(root), before);

    // Human mode names the next step.
    let output = Command::new(BIN)
        .args(["space", "meta", "set", "--icon", "x"])
        .current_dir(root)
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.starts_with("error[REPOSITORY_ACCESS_DENIED]"),
        "{stderr}"
    );
    assert!(
        stderr.contains("hint: Verify repository access"),
        "{stderr}"
    );
}

/// A related Collection in a child Space with its own repository: the
/// reverse relation write makes that repository part of the change.
#[test]
fn a_reverse_write_into_another_repository_is_authorized_before_the_first_write() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"crm","path":"crm","repo":null}]}"#,
    );
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - { name: Status, type: text }\n  - name: Owner\n    type: relation\n    relation: contacts\n    relation_scope: { type: space, id: crm }\n    limit: one\n    two_way: Tasks\nviews: []\n",
    );
    let crm = root.join("crm");
    write(&crm.join(".svode/config.json"), r#"{"name":"CRM"}"#);
    write(&crm.join("README.md"), "---\ntitle: CRM\n---\n");
    write(
        &crm.join("contacts/schema.yaml"),
        "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    relation_scope: root\n    two_way: Owner\nviews: []\n",
    );
    write(
        &crm.join("contacts/README.md"),
        "---\ntitle: Contacts\n---\n",
    );
    write(&crm.join("contacts/Bob.md"), "---\ntitle: Bob\n---\n");
    commit(&crm);
    git(
        &crm,
        &["remote", "add", "origin", "https://example.invalid/crm.git"],
    );
    let fields = input(root, "fields.json", r#"{"Owner":"Bob.md","Status":"Done"}"#);
    let before = (
        source(root, "tasks/alpha.md"),
        std::fs::read_to_string(crm.join("contacts/Bob.md")).unwrap(),
    );
    let (exit, value) = json(
        root,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &fields,
        ],
        None,
    );
    assert_eq!(exit, 1, "{value}");
    assert_eq!(code(&value), "REPOSITORY_ACCESS_DENIED");
    assert_eq!(
        (
            source(root, "tasks/alpha.md"),
            std::fs::read_to_string(crm.join("contacts/Bob.md")).unwrap(),
        ),
        before
    );
    // Without the relation the change touches only the local root.
    let status = input(root, "status.json", r#"{"Status":"Done"}"#);
    ok(
        root,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &status,
        ],
    );
}

#[test]
fn a_held_repository_is_busy_and_names_the_target_in_its_space() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    let column = input(root, "column.json", r#"{"name":"Stage","type":"text"}"#);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &std::collections::BTreeSet::from([root.clone()]),
            &[],
        ))
        .unwrap();
    let before = snapshot(root);
    let (exit, value) = json(
        root,
        &[
            "page",
            "meta",
            "set",
            "--path",
            "notes/today.md",
            "--icon",
            "x",
        ],
        None,
    );
    assert_eq!((exit, code(&value)), (1, "SOURCE_BUSY"), "{value}");
    assert_eq!(value["error"]["path"], "notes/today.md");
    let (exit, value) = json(
        root,
        &[
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            &column,
        ],
        None,
    );
    assert_eq!((exit, code(&value)), (1, "SOURCE_BUSY"), "{value}");
    let path = value["error"]["path"].as_str().unwrap();
    assert!(path.starts_with("tasks/"), "{path}");
    let mut after = snapshot(root);
    after.retain(|path, _| !path.starts_with(".svode") || path.ends_with("config.json"));
    let mut expected = before;
    expected.retain(|path, _| !path.starts_with(".svode") || path.ends_with("config.json"));
    assert_eq!(after, expected);

    drop(guard);
    ok(
        root,
        &[
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            &column,
        ],
    );
}

async fn rows(database: &Path, query: &str) -> Vec<sqlx::sqlite::SqliteRow> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(database)
                .read_only(true),
        )
        .await
        .unwrap();
    let rows = sqlx::query(query).fetch_all(&pool).await.unwrap();
    pool.close().await;
    rows
}

/// The desktop app had read the Routines of the Collection and automatic
/// Routines are enabled for it on this device.
async fn enable_event_routines(root: &Path) {
    use svode_core::routines::authority;
    use svode_core::routines::model::{RoutineLiveEvidence, RoutineOwnerInputKind};
    use svode_core::routines::service::{read_catalog, resolve_owner};
    use svode_core::routines::store_state::RoutineStoreState;

    let owner = resolve_owner(
        root,
        root,
        "root",
        "tasks",
        RoutineOwnerInputKind::CollectionDirectory,
    )
    .unwrap();
    let stores = RoutineStoreState::new();
    let index = svode_core::index::state::IndexRuntimeState::default();
    read_catalog(&stores, &index, &RoutineLiveEvidence::default(), &owner)
        .await
        .unwrap();
    authority::set_key(&owner.space_path, &owner.identity(), true).unwrap();
    stores.close_project(root).await;
}

fn event_routine(id: &str, field: &str) -> String {
    format!(
        "---\nid: {id}\nname: On {field}\nenabled: true\ntrigger:\n  type: event\n  event: collection.field_changed\n  match:\n    field: {field}\naction:\n  type: update_properties\n  target: trigger.entry\n  set:\n    Reviewed: true\n---\nReview.\n"
    )
}

#[test]
fn a_field_change_records_its_routine_event_without_the_edits_of_other_programs() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    write(
        &root.join("tasks/.routines/status.md"),
        &event_routine("01arz3ndektsv4rrffq69g5fav", "Status"),
    );
    write(
        &root.join("tasks/.routines/estimate.md"),
        &event_routine("01arz3ndektsv4rrffq69g5fb0", "Estimate"),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(enable_event_routines(root));

    // A read observes the item; then another program edits a field
    // directly while no Svode process watches the files.
    ok(root, &["collection", "query", "--collection", "tasks"]);
    std::fs::write(
        root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\nEstimate: 8\n---\nAlpha body\n",
    )
    .unwrap();

    let fields = input(root, "fields.json", r#"{"Status":"Done"}"#);
    ok(
        root,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            &fields,
        ],
    );

    let events = runtime.block_on(rows(
        &root.join(".svode/routines.db"),
        "SELECT routine_id, event_type, entry_path, property_key, payload_json, state FROM routine_event_queue",
    ));
    use sqlx::Row;
    assert_eq!(
        events.len(),
        1,
        "only the change of the command is an event"
    );
    let event = &events[0];
    assert!(event.get::<String, _>("routine_id").starts_with("routine:"));
    assert_eq!(
        event.get::<String, _>("event_type"),
        "collection.field_changed"
    );
    assert_eq!(event.get::<String, _>("entry_path"), "tasks/alpha.md");
    assert_eq!(
        event.get::<Option<String>, _>("property_key").as_deref(),
        Some("Status")
    );
    assert_eq!(event.get::<String, _>("state"), "pending");
    let payload: Value = serde_json::from_str(&event.get::<String, _>("payload_json")).unwrap();
    assert_eq!(payload["oldValue"], "Todo");
    assert_eq!(payload["newValue"], "Done");
    assert_eq!(payload["sourceKind"], "managed");
    // No Routine runs without the desktop app.
    let runs = runtime.block_on(rows(
        &root.join(".svode/routines.db"),
        "SELECT routine_run_id FROM routine_runs",
    ));
    assert!(runs.is_empty());
}

#[test]
fn a_change_in_a_child_space_publishes_into_the_index_of_that_space() {
    let Some((_temp, root)) = fixture() else {
        return;
    };
    let root = &root;
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null}]}"#,
    );
    write(
        &root.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(
        &root.join("child/bugs/schema.yaml"),
        "columns:\n  - { name: Status, type: text }\nviews: []\n",
    );
    write(
        &root.join("child/bugs/README.md"),
        "---\ntitle: Bugs\n---\n",
    );
    write(
        &root.join("child/bugs/one.md"),
        "---\ntitle: One\nStatus: Open\n---\n",
    );
    let fields = input(root, "fields.json", r#"{"Status":"Closed"}"#);
    ok(
        root,
        &[
            "--space",
            "child",
            "item",
            "fields",
            "set",
            "--path",
            "bugs/one.md",
            "--fields-file",
            &fields,
        ],
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    use sqlx::Row;
    let child = runtime.block_on(rows(
        &root.join("child/.svode/index.db"),
        "SELECT fields FROM entries WHERE file_path = 'bugs/one.md'",
    ));
    assert_eq!(child.len(), 1);
    assert!(child[0].get::<String, _>("fields").contains("Closed"));
    if root.join(".svode/index.db").exists() {
        let leaked = runtime.block_on(rows(
            &root.join(".svode/index.db"),
            "SELECT file_path FROM entries WHERE file_path LIKE 'child/%'",
        ));
        assert!(leaked.is_empty(), "the root index holds no child source");
    }
    assert!(root.join("child/.svode/routines.db").is_file());
}
