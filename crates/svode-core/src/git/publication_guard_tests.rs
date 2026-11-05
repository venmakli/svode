use super::reuse_tests::{count, traced};
use super::*;

const MARKERS: &str = "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n";

fn write_commit(repo: &Path, files: &[(&str, &str)], message: &str) -> String {
    for (file, content) in files {
        let path = repo.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
        git(repo, &["add", file]);
    }
    git(repo, &["commit", "-m", message]);
    git(repo, &["rev-parse", "HEAD"])
}

/// The path, commit and finding of a guard refusal.
fn guarded<T: std::fmt::Debug>(result: Result<T, GitError>) -> (String, String, ContentFinding) {
    match result {
        Err(GitError::PublicationBlocked {
            reason:
                PublicationBlockReason::Content {
                    path,
                    commit,
                    finding,
                },
            ..
        }) => (path, commit, finding),
        other => panic!("expected the publication guard, got {other:?}"),
    }
}

fn remote_main(f: &Fixture) -> String {
    git(&f.remote, &["rev-parse", "main"])
}

#[tokio::test]
async fn commit_with_marker_lines_is_not_published_and_names_file_and_commit() {
    let f = Fixture::new();
    let published = remote_main(&f);
    let marked = write_commit(&f.root, &[("notes/plan.md", MARKERS)], "marked");
    write_commit(&f.root, &[("other.md", "clean\n")], "later clean commit");
    assert_eq!(
        guarded(f.push().await),
        (
            "notes/plan.md".to_owned(),
            marked,
            ContentFinding::ConflictMarkers
        )
    );
    assert_eq!(remote_main(&f), published);

    // Recovery: fix the file and commit; the next publication goes through.
    write_commit(&f.root, &[("notes/plan.md", "resolved\n")], "fixed");
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(remote_main(&f), git(&f.root, &["rev-parse", "HEAD"]));
}

#[tokio::test]
async fn marker_size_of_the_path_decides_which_lines_are_markers() {
    let f = Fixture::new();
    write_commit(
        &f.root,
        &[(".gitattributes", "*.yaml conflict-marker-size=10\n")],
        "marker size",
    );
    // Seven-character lines are not markers of a path with size 10.
    write_commit(
        &f.root,
        &[("data.yaml", "<<<<<<< ours\na: 1\n>>>>>>> theirs\n")],
        "short lines",
    );
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    let published = remote_main(&f);
    let marked = write_commit(
        &f.root,
        &[(
            "data.yaml",
            "<<<<<<<<<< ours\na: 1\n==========\na: 2\n>>>>>>>>>> theirs\n",
        )],
        "size 10 markers",
    );
    assert_eq!(
        guarded(f.push().await),
        (
            "data.yaml".to_owned(),
            marked,
            ContentFinding::ConflictMarkers
        )
    );
    assert_eq!(remote_main(&f), published);
}

#[tokio::test]
async fn setext_heading_underlined_by_a_side_separator_publishes() {
    let f = Fixture::new();
    write_commit(
        &f.root,
        &[(".gitattributes", "wide.md conflict-marker-size=10\n")],
        "marker size",
    );
    write_commit(
        &f.root,
        &[
            ("doc.md", "# Doc\n\nTitle\n=======\n\nBody\n"),
            ("spaced.md", "Title\n======= \t\nBody\n"),
            ("wide.md", "Heading\n==========\nBody\n"),
        ],
        "setext headings",
    );
    let log = traced(&f, "");
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(remote_main(&f), git(&f.root, &["rev-parse", "HEAD"]));
    // Telling the line apart reads the published version locally.
    assert_eq!(count(&log, "cat-file blob"), 3);
    assert_eq!(count(&log, "fetch"), 0);
}

#[tokio::test]
async fn lone_opening_closing_or_base_marker_line_is_not_published() {
    // Git writes an opening marker with its label; since Git 2.56 a bare
    // `<<<<<<<` line is not a marker to `git diff --check` either.
    let lines = [
        "<<<<<<< ours\n",
        ">>>>>>> theirs\n",
        "|||||||\n",
        "||||||| base\n",
    ];
    for line in lines {
        let f = Fixture::new();
        let published = remote_main(&f);
        let marked = write_commit(
            &f.root,
            &[("page.md", &format!("Title\n=======\n{line}text\n"))],
            "marker line",
        );
        assert_eq!(
            guarded(f.push().await),
            (
                "page.md".to_owned(),
                marked,
                ContentFinding::ConflictMarkers
            ),
            "{line:?}"
        );
        assert_eq!(remote_main(&f), published);
    }
}

#[tokio::test]
async fn separator_of_one_file_does_not_hide_the_marker_of_the_next() {
    let f = Fixture::new();
    let published = remote_main(&f);
    write_commit(&f.root, &[("a.md", "Title\n=======\n")], "heading");
    let marked = write_commit(&f.root, &[("b.md", ">>>>>>> theirs\n")], "marker");
    write_commit(&f.root, &[("c.md", "Other\n=======\n")], "another heading");
    assert_eq!(
        guarded(f.push().await),
        ("b.md".to_owned(), marked, ContentFinding::ConflictMarkers)
    );
    assert_eq!(remote_main(&f), published);
}

#[tokio::test]
async fn whitespace_findings_of_the_git_check_do_not_stop_publication() {
    let f = Fixture::new();
    write_commit(
        &f.root,
        &[("page.md", "trailing   \n \tspace before tab\n\n\n")],
        "whitespace",
    );
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(remote_main(&f), git(&f.root, &["rev-parse", "HEAD"]));
}

#[tokio::test]
async fn unreadable_service_files_are_not_published() {
    let cases: [(&str, &str); 5] = [
        ("tasks/schema.yaml", "columns: [\n"),
        (
            "tasks/schema.yaml",
            "columns: []\nviews:\n  - type: table\n    name: [broken]\n",
        ),
        (".svode/config.json", "{\"description\": \"no name\"}\n"),
        ("Space/.svode/config.json", "{\"name\": \"S\",\n"),
        (".svode/order.json", "{\".\": \"not a list\"}\n"),
    ];
    for (path, content) in cases {
        let f = Fixture::new();
        let published = remote_main(&f);
        let commit = write_commit(&f.root, &[(path, content)], "service file");
        assert_eq!(
            guarded(f.push().await),
            (path.to_owned(), commit, ContentFinding::Unreadable),
            "{path}: {content}"
        );
        assert_eq!(remote_main(&f), published, "{path}");
    }
}

#[tokio::test]
async fn readable_service_files_with_unknown_keys_publish() {
    let f = Fixture::new();
    write_commit(
        &f.root,
        &[
            (
                "tasks/schema.yaml",
                "columns: []\nviews:\n  - name: Plan\n    type: timeline\n    future: 1\nfuture_key: true\n",
            ),
            (
                ".svode/config.json",
                "{\"name\": \"Project\", \"futureKey\": {\"a\": 1}}\n",
            ),
            (".svode/order.json", "{\".\": [\"a\", \"b\"]}\n"),
            // Hidden folders hold no Collection schema.
            ("tasks/.templates/schema.yaml", "not: [yaml\n"),
            ("docs/config.json", "not json\n"),
        ],
        "service files",
    );
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(remote_main(&f), git(&f.root, &["rev-parse", "HEAD"]));
}

#[tokio::test]
async fn first_publish_checks_the_whole_tree() {
    let f = Fixture::new();
    let marked = write_commit(&f.root, &[("legacy.md", MARKERS)], "published markers");
    git(&f.root, &["push", "origin", "main"]);
    // Published markers are not what an ordinary push sends.
    write_commit(&f.root, &[("new.md", "clean\n")], "clean");
    assert_eq!(f.push().await.unwrap().exit_code, 0);

    git(&f.remote, &["update-ref", "-d", "refs/heads/main"]);
    git(&f.root, &["branch", "--unset-upstream"]);
    assert_eq!(
        guarded(super::push(&f.cli, &f.root, true).await),
        (
            "legacy.md".to_owned(),
            marked,
            ContentFinding::ConflictMarkers
        )
    );
    assert!(
        Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", "refs/heads/main"])
            .current_dir(&f.remote)
            .output()
            .unwrap()
            .stdout
            .is_empty()
    );
}

#[tokio::test]
async fn stopped_space_does_not_let_the_project_publication_through() {
    let f = Fixture::new();
    let marked = write_commit(&f.child, &[("page.md", MARKERS)], "space markers");
    assert_eq!(
        guarded(super::push(&f.cli, &f.child, false).await),
        (
            "page.md".to_owned(),
            marked,
            ContentFinding::ConflictMarkers
        )
    );
    f.pointer();
    let published = remote_main(&f);
    assert_eq!(
        blocked_spaces(f.push().await),
        one(SpaceBlockClass::LocalCommits)
    );
    assert_eq!(remote_main(&f), published);
}

#[tokio::test]
async fn sync_integrates_incoming_work_and_stops_only_the_push() {
    let f = Fixture::new();
    let peer = f._temp.path().join("peer");
    git(
        f._temp.path(),
        &["clone", f.remote.to_str().unwrap(), peer.to_str().unwrap()],
    );
    git(&peer, &["config", "user.name", "Peer"]);
    git(&peer, &["config", "user.email", "peer@example.test"]);
    let incoming = write_commit(&peer, &[("peer.md", "from a colleague\n")], "incoming");
    git(&peer, &["push", "origin", "main"]);
    let marked = write_commit(&f.root, &[("mine.md", MARKERS)], "mine");
    assert_eq!(
        guarded(crate::git::sync::sync(&f.cli, &f.root).await),
        (
            "mine.md".to_owned(),
            marked,
            ContentFinding::ConflictMarkers
        )
    );
    assert_eq!(remote_main(&f), incoming);
    git(&f.root, &["merge-base", "--is-ancestor", &incoming, "HEAD"]);
}

#[tokio::test]
async fn clean_commit_publishes_without_extra_network_calls() {
    let f = Fixture::new();
    write_commit(&f.root, &[("page.md", "clean\n")], "clean");
    let log = traced(&f, "");
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(remote_main(&f), git(&f.root, &["rev-parse", "HEAD"]));
    // The guard ran on local objects only.
    assert_eq!(count(&log, "diff --check"), 1);
    assert_eq!(count(&log, "push --dry-run"), 1);
    assert_eq!(count(&log, "ls-remote"), 2);
    assert_eq!(count(&log, "push --recurse-submodules=check"), 1);
    assert_eq!(count(&log, "fetch"), 0);
}

#[tokio::test]
async fn nothing_outgoing_runs_no_guard() {
    let f = Fixture::new();
    let log = traced(&f, "");
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(count(&log, "diff "), 0);
}
