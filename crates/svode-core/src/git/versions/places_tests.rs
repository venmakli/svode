//! Places of version messages (DF-283): the root of the Project and of every
//! Space is named by the `name` of its `.svode/config.json`, an ordinary
//! folder by its README or its name in the tree, and the directory a clone
//! lies in on the device never appears in a message — for «Commit all»,
//! automatic versions, versions of turns and the «Commit with agent» context.

use std::path::Path;
use std::time::Duration;

use super::auto::{AutoVersions, Closing, close};
use super::turns::{self, TurnWrap};
use super::{MessageLanguage, PendingOperation, PlannedVersion, plan, uncommitted};
use crate::git::pending::{OperationId, StructuralOp};
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::save::save;
use crate::git::staging_tests::{TestHost, cli, git, repo, write};
use crate::git::state::GitRuntime;

const EN: MessageLanguage = MessageLanguage::En;
const PAUSE: Duration = Duration::from_secs(60);

fn config(name: &str) -> String {
    format!("{{\"name\":\"{name}\"}}\n")
}

/// The tests rewrite an order to one of another length: a rewrite of the
/// same size within one tick of a coarse file clock (Linux) leaves the stat
/// Git keeps in the index matching, and the change goes unseen.
fn order(entry: &str) -> String {
    format!("{{\"\":[\"{entry}\"]}}\n")
}

fn page(title: &str, body: &str) -> String {
    format!("---\ntitle: {title}\n---\n{body}")
}

async fn commit_all(root: &Path) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    git(&cli, root, &["commit", "-q", "-m", "Base"]).await;
}

/// Every message after the first `base` commits, newest first.
async fn messages(root: &Path, base: usize) -> Vec<String> {
    let mut all = git(&cli(), root, &["log", "--format=%B%x00"])
        .await
        .split('\0')
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>();
    all.truncate(all.len() - base);
    all
}

async fn planned(
    root: &Path,
    operations: &[PendingOperation],
) -> (Vec<PlannedVersion>, Vec<String>) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    let versions = plan(&cli, root, &[".".to_string()], operations, EN)
        .await
        .expect("plan");
    let headers = versions
        .iter()
        .map(|version| version.message.header.clone())
        .collect();
    (versions, headers)
}

fn dir_name(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

fn without(messages: &[String], names: &[&str]) {
    for message in messages {
        for name in names {
            assert!(!message.contains(name), "{name} in {message:?}");
        }
    }
}

fn content_on(repo: &Path) {
    write_user_policy(
        repo,
        &GitUserPolicy {
            auto_commit_content: true,
            ..GitUserPolicy::default()
        },
    )
    .expect("write policy");
}

/// A born repository named `name` in its config, with a committed order.
async fn named_root(name: &str) -> tempfile::TempDir {
    let tmp = repo(&cli(), true).await;
    let root = tmp.path();
    write(root, ".svode/config.json", &config(name));
    write(root, ".svode/order.json", &order("a"));
    write(root, ".gitignore", ".svode/local.json\n");
    commit_all(root).await;
    tmp
}

#[tokio::test]
async fn commit_all_names_the_project_and_its_spaces_by_their_names_not_their_directories() {
    let cli = cli();
    let runtime = GitRuntime::with_cli(cli.clone());
    let host = TestHost::default();
    let project = repo(&cli, true).await;
    let root = project.path();
    // A Submodule Space `team` named «Команда».
    let team = root.join("team");
    std::fs::create_dir(&team).unwrap();
    for args in [
        &["init", "-q"][..],
        &["config", "user.name", "Test"],
        &["config", "user.email", "test@example.test"],
        &["config", "commit.gpgsign", "false"],
    ] {
        git(&cli, &team, args).await;
    }
    write(&team, ".svode/config.json", &config("Команда"));
    write(&team, ".svode/order.json", &order("a"));
    write(&team, ".gitignore", "*.log\n");
    commit_all(&team).await;
    write(
        root,
        ".gitmodules",
        "[submodule \"team\"]\n\tpath = team\n\turl = ./team\n",
    );
    // The Project «QA Project» and an Inline Space `docs` named «Handbook».
    write(root, ".svode/config.json", &config("QA Project"));
    write(root, ".svode/order.json", &order("a"));
    write(root, ".gitignore", "*.log\n");
    write(root, "docs/.svode/config.json", &config("Handbook"));
    write(root, "docs/.svode/order.json", &order("a"));
    write(root, "docs/.gitignore", "*.log\n");
    commit_all(root).await;
    // An Independent Space «Indie» in a directory of its own.
    let indie = named_root("Indie").await;

    for space in [root, &root.join("docs"), &team, indie.path()] {
        write(space, ".svode/order.json", &order("second"));
        write(space, ".gitignore", "*.log\n*.tmp\n");
    }

    save(&runtime, &host, Some(root), &team, None, EN)
        .await
        .expect("commit all in the Submodule Space");
    save(&runtime, &host, Some(root), &root.join("docs"), None, EN)
        .await
        .expect("commit all in the Inline Space");
    save(&runtime, &host, Some(root), root, None, EN)
        .await
        .expect("commit all in the Project");
    save(&runtime, &host, None, indie.path(), None, EN)
        .await
        .expect("commit all in the Independent Space");

    let project_messages = messages(root, 2).await;
    for expected in [
        "Handbook: reorder",
        "Handbook: settings",
        "QA Project: reorder",
        "QA Project: settings",
    ] {
        assert!(
            project_messages.iter().any(|message| message == expected),
            "{expected} in {project_messages:#?}"
        );
    }
    let team_messages = messages(&team, 1).await;
    assert_eq!(
        team_messages,
        ["Команда: settings", "Команда: reorder"],
        "{team_messages:#?}"
    );
    let indie_messages = messages(indie.path(), 2).await;
    assert_eq!(
        indie_messages,
        ["Indie: settings", "Indie: reorder"],
        "{indie_messages:#?}"
    );
    let clones = [dir_name(root), dir_name(indie.path())];
    let clones = clones.iter().map(String::as_str).collect::<Vec<_>>();
    without(&project_messages, &clones);
    without(&team_messages, &["team"]);
    without(&indie_messages, &clones);
}

#[tokio::test]
async fn folders_are_named_by_their_readme_or_name_and_an_unnamed_root_by_nothing() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    // The root has a config without a name; the Inline Space `inline` too,
    // and its README title does not name it.
    write(root, ".svode/config.json", "{\"icon\":\"x\"}\n");
    write(root, ".svode/order.json", &order("a"));
    write(root, "inline/.svode/config.json", "{\"icon\":\"x\"}\n");
    write(root, "inline/.svode/order.json", &order("a"));
    write(root, "inline/README.md", &page("Inline home", "Text\n"));
    write(root, "Guide/README.md", &page("Guide Book", "Text\n"));
    write(root, "Guide/.svode/order.json", &order("a"));
    write(root, "plain/.svode/order.json", &order("a"));
    commit_all(root).await;
    for dir in ["", "inline/", "Guide/", "plain/"] {
        write(root, &format!("{dir}.svode/order.json"), &order("second"));
    }
    write(root, ".gitignore", "*.log\n");

    let (_, headers) = planned(root, &[]).await;
    for expected in [
        "Reorder",
        "Settings",
        "inline: reorder",
        "Guide Book: reorder",
        "plain: reorder",
    ] {
        assert!(
            headers.iter().any(|header| header == expected),
            "{expected} in {headers:#?}"
        );
    }
    assert_eq!(headers.len(), 5, "{headers:#?}");
    without(&headers, &[&dir_name(root)]);

    // A config that does not read names nothing either.
    write(root, ".svode/config.json", "<<<<<<< ours\n");
    commit_all(root).await;
    write(root, ".svode/order.json", &order("c"));
    let (_, headers) = planned(root, &[]).await;
    assert_eq!(headers, ["Reorder"]);
}

#[tokio::test]
async fn a_registered_reorder_names_its_folder_and_an_untitled_page_its_file() {
    let cli = cli();
    let tmp = named_root("QA Project").await;
    let root = tmp.path();
    write(root, "Guide/README.md", &page("Guide Book", "Text\n"));
    write(root, "Guide/.svode/order.json", &order("a"));
    write(root, "Untitled note.md", &page("\"\"", "Old\n"));
    write(root, "README.md", &page("\"\"", "Home\n"));
    commit_all(root).await;
    write(root, "Guide/.svode/order.json", &order("second"));
    write(root, ".svode/order.json", &order("second"));
    write(root, "Untitled note.md", &page("\"\"", "New\n"));
    write(root, "README.md", &page("\"\"", "Home 2\n"));
    git(&cli, root, &["add", "--all"]).await;
    let reorder = |path: &str| PendingOperation {
        id: Some(OperationId::next()),
        op: Some(StructuralOp::Reorder),
        relocation: None,
        created: None,
        paths: vec![path.to_string()],
    };

    let (versions, headers) = planned(
        root,
        &[
            reorder("Guide/.svode/order.json"),
            reorder(".svode/order.json"),
        ],
    )
    .await;
    for expected in [
        "Guide Book: reorder",
        "QA Project: reorder",
        "Untitled note: edit text",
        "QA Project: edit text",
    ] {
        assert!(
            headers.iter().any(|header| header.starts_with(expected)),
            "{expected} in {headers:#?}"
        );
    }
    let texts = versions
        .iter()
        .map(|version| version.message.text())
        .collect::<Vec<_>>();
    without(&texts, &["order.json", &dir_name(root)]);
}

#[tokio::test]
async fn an_automatic_version_names_the_project() {
    let tmp = named_root("QA Project").await;
    let root = tmp.path();
    content_on(root);
    write(root, ".svode/order.json", &order("second"));
    let fixture = (GitRuntime::with_cli(cli()), TestHost::default());

    let closed = close(&fixture.0, &fixture.1, root, &Closing::all(PAUSE), EN)
        .await
        .expect("close");

    assert!(
        matches!(closed, AutoVersions::Done { commits: 1, .. }),
        "{closed:?}"
    );
    assert_eq!(messages(root, 2).await, ["QA Project: reorder"]);
}

#[tokio::test]
async fn a_turn_version_names_the_project() {
    let tmp = named_root("QA Project").await;
    let root = tmp.path();
    content_on(root);
    let runtime = GitRuntime::with_cli(cli());
    let host = TestHost::default();
    turns::begin(&runtime, &host, root, "df283:turn", TurnWrap::Version, EN).await;
    write(root, ".svode/order.json", &order("second"));

    turns::end(&runtime, &host, "df283:turn", EN).await;

    assert_eq!(messages(root, 2).await, ["QA Project: reorder"]);
}

#[tokio::test]
async fn the_commit_with_agent_context_names_the_project() {
    let tmp = named_root("QA Project").await;
    let root = tmp.path();
    write(root, ".svode/order.json", &order("second"));
    let runtime = GitRuntime::with_cli(cli());

    let found = uncommitted(&runtime, root, &[".svode/order.json".to_string()], EN)
        .await
        .expect("uncommitted");

    let headers = found
        .groups
        .iter()
        .map(|group| group.header.clone())
        .collect::<Vec<_>>();
    assert_eq!(headers, ["QA Project: reorder"]);
    without(&headers, &[&dir_name(root)]);
}
