use super::inspection::read_item;
use svode_core::git::cli::GitCli;
use svode_core::git::ops;

async fn commit_file(
    cli: &GitCli,
    space_dir: &std::path::Path,
    file_path: &str,
) -> Result<bool, svode_core::git::GitError> {
    ops::commit_paths(cli, space_dir, &[file_path.to_string()]).await
}

async fn commit_all(
    cli: &GitCli,
    space_dir: &std::path::Path,
) -> Result<bool, svode_core::git::GitError> {
    let paths = ops::status(cli, space_dir)
        .await?
        .files
        .into_iter()
        .map(|file| file.path)
        .collect::<Vec<_>>();
    ops::commit_paths(cli, space_dir, &paths).await
}

async fn repo() -> (tempfile::TempDir, GitCli) {
    let dir = tempfile::tempdir().unwrap();
    let cli = GitCli::detect().unwrap();
    cli.exec(dir.path(), &["init"]).await.unwrap();
    cli.exec(dir.path(), &["config", "user.email", "test@example.com"])
        .await
        .unwrap();
    cli.exec(dir.path(), &["config", "user.name", "Test"])
        .await
        .unwrap();
    (dir, cli)
}

#[tokio::test]
async fn inspection_reads_unborn_modified_deleted_and_index_only_without_writes() {
    let (dir, cli) = repo().await;
    let path = dir.path().join("note.md");
    std::fs::write(&path, "first\n").unwrap();
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "1".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(item["before"], "");
    assert_eq!(item["after"], "first\n");
    assert!(
        ops::commit_paths(&cli, dir.path(), &["note.md".into()])
            .await
            .unwrap()
    );
    std::fs::write(&path, "second\n").unwrap();
    ops::add(&cli, dir.path(), "note.md").await.unwrap();
    std::fs::write(&path, "first\n").unwrap();
    let index_before = cli
        .exec(dir.path(), &["diff", "--cached"])
        .await
        .unwrap()
        .stdout;
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "2".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(item["state"], "no_content_diff");
    assert_eq!(
        index_before,
        cli.exec(dir.path(), &["diff", "--cached"])
            .await
            .unwrap()
            .stdout
    );
    std::fs::remove_file(&path).unwrap();
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "3".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(item["before"], "first\n");
    assert_eq!(item["after"], "");
    assert!(
        read_item(&cli, dir.path(), "../note.md", "4".into())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn selected_commit_preserves_unrelated_staged_content() {
    let (dir, cli) = repo().await;
    for name in ["note.md", "other.md"] {
        std::fs::write(dir.path().join(name), "initial\n").unwrap();
    }
    commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("other.md"), "staged\n").unwrap();
    ops::add(&cli, dir.path(), "other.md").await.unwrap();
    std::fs::write(dir.path().join("other.md"), "working\n").unwrap();
    std::fs::write(dir.path().join("note.md"), "selected\n").unwrap();
    let staged = cli
        .exec(dir.path(), &["show", ":other.md"])
        .await
        .unwrap()
        .stdout;
    commit_file(&cli, dir.path(), "note.md").await.unwrap();
    assert_eq!(
        cli.exec(dir.path(), &["show", "HEAD:other.md"])
            .await
            .unwrap()
            .stdout,
        "initial\n"
    );
    assert_eq!(
        cli.exec(dir.path(), &["show", ":other.md"])
            .await
            .unwrap()
            .stdout,
        staged
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("other.md")).unwrap(),
        "working\n"
    );
}

#[tokio::test]
async fn inspection_bounds_text_and_rejects_child_repository_and_symlink_escape() {
    let (dir, cli) = repo().await;
    for (name, bytes, state) in [
        ("large.md", vec![b'a'; 600 * 1024], "truncated"),
        ("large.pdf", vec![b'a'; 600 * 1024], "binary"),
        ("invalid.md", vec![255], "invalid_encoding"),
        ("binary.md", vec![0, 1], "binary"),
    ] {
        std::fs::write(dir.path().join(name), bytes).unwrap();
        let item = serde_json::to_value(
            read_item(&cli, dir.path(), name, "generation".into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(item["state"], state);
        assert_eq!(item["generation"], "generation");
        assert!(item["after"].is_null());
    }
    let child = dir.path().join("child");
    std::fs::create_dir(&child).unwrap();
    cli.exec(&child, &["init"]).await.unwrap();
    std::fs::write(child.join("note.md"), "child").unwrap();
    assert!(
        read_item(&cli, dir.path(), "child/note.md", "1".into())
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("note.md"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        assert!(
            read_item(&cli, dir.path(), "escape/note.md", "1".into())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn index_only_save_clears_selected_index_without_creating_commit() {
    let (dir, cli) = repo().await;
    std::fs::write(dir.path().join("[note].md"), "base\n").unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    let head = cli
        .exec(dir.path(), &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .stdout;
    std::fs::write(dir.path().join("[note].md"), "staged\n").unwrap();
    ops::add(&cli, dir.path(), "[note].md").await.unwrap();
    std::fs::write(dir.path().join("[note].md"), "base\n").unwrap();
    assert!(
        !ops::commit_paths(&cli, dir.path(), &["[note].md".into()])
            .await
            .unwrap()
    );
    assert_eq!(
        cli.exec(dir.path(), &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .stdout,
        head
    );
    assert!(
        ops::status(&cli, dir.path())
            .await
            .unwrap()
            .files
            .is_empty()
    );
}

#[tokio::test]
async fn aggregate_scope_is_rechecked_and_exceptional_items_are_local() {
    let (dir, cli) = repo().await;
    std::fs::create_dir(dir.path().join("contract")).unwrap();
    for name in [
        "README.md",
        "schema.yaml",
        "app.yaml",
        "source.ts",
        "manual.pdf",
    ] {
        std::fs::write(dir.path().join("contract").join(name), "base\n").unwrap();
    }
    commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("contract/source.ts"), "changed\n").unwrap();
    cli.exec(
        dir.path(),
        &["mv", "contract/README.md", "contract/renamed.md"],
    )
    .await
    .unwrap();
    let scope = || {
        serde_json::from_value(serde_json::json!({"kind": "directory", "path": "contract"}))
            .unwrap()
    };
    let renamed = super::inspection::read_scoped_item(
        &cli,
        dir.path(),
        "contract/renamed.md",
        "1".into(),
        Some(scope()),
    )
    .await
    .unwrap();
    let renamed = serde_json::to_value(renamed).unwrap();
    assert_eq!(renamed["previousPath"], "contract/README.md");
    let binary = super::inspection::read_scoped_item(
        &cli,
        dir.path(),
        "contract/manual.pdf",
        "1".into(),
        Some(scope()),
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(binary).unwrap()["state"], "binary");
    assert!(
        super::inspection::read_scoped_item(
            &cli,
            dir.path(),
            "outside.md",
            "1".into(),
            Some(scope())
        )
        .await
        .is_err()
    );
    let missing = super::inspection::read_scoped_item(
        &cli,
        dir.path(),
        "contract/gone.md",
        "1".into(),
        Some(scope()),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(missing).unwrap()["state"],
        "disappeared"
    );
    let root_scope =
        serde_json::from_value(serde_json::json!({"kind": "repository", "path": ""})).unwrap();
    assert!(
        super::inspection::read_scoped_item(
            &cli,
            dir.path(),
            "contract/source.ts",
            "1".into(),
            Some(root_scope)
        )
        .await
        .is_ok()
    );
}

#[tokio::test]
async fn project_status_contains_inline_paths_and_gitlink_but_not_child_working_trees() {
    let (dir, cli) = repo().await;
    let (child, _) = repo().await;
    std::fs::write(child.path().join("child.md"), "base\n").unwrap();
    commit_all(&cli, child.path()).await.unwrap();
    let added = cli
        .exec(
            dir.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child.path().to_str().unwrap(),
                "sub",
            ],
        )
        .await
        .unwrap();
    assert_eq!(added.exit_code, 0, "{}", added.stderr);
    std::fs::create_dir(dir.path().join("inline")).unwrap();
    std::fs::write(dir.path().join("inline/README.md"), "base\n").unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("sub/child.md"), "dirty child\n").unwrap();
    std::fs::write(dir.path().join("inline/README.md"), "dirty inline\n").unwrap();
    let independent = dir.path().join("independent");
    std::fs::create_dir(&independent).unwrap();
    cli.exec(&independent, &["init"]).await.unwrap();
    std::fs::write(independent.join("note.md"), "independent\n").unwrap();
    let status = ops::status(&cli, dir.path()).await.unwrap();
    assert_eq!(
        status
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["inline/README.md"]
    );
    let inline = ops::status(&cli, &dir.path().join("inline")).await.unwrap();
    assert_eq!(inline.files[0].path, "README.md");
    assert_eq!(
        ops::status(&cli, &dir.path().join("sub"))
            .await
            .unwrap()
            .files[0]
            .path,
        "child.md"
    );
    cli.exec(&dir.path().join("sub"), &["config", "user.name", "Test"])
        .await
        .unwrap();
    cli.exec(
        &dir.path().join("sub"),
        &["config", "user.email", "test@example.com"],
    )
    .await
    .unwrap();
    commit_all(&cli, &dir.path().join("sub")).await.unwrap();
    assert!(
        ops::status(&cli, dir.path())
            .await
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == "sub")
    );
    let pointer = read_item(&cli, dir.path(), "sub", "1".into())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(pointer).unwrap()["state"], "gitlink");
}

#[tokio::test]
async fn conflicts_and_non_regular_sources_never_become_normal_text() {
    let (dir, cli) = repo().await;
    std::fs::write(dir.path().join("note.md"), "base\n").unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    let base_branch = ops::status(&cli, dir.path()).await.unwrap().branch;
    cli.exec(dir.path(), &["checkout", "-b", "other"])
        .await
        .unwrap();
    std::fs::write(dir.path().join("note.md"), "other\n").unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    cli.exec(dir.path(), &["checkout", &base_branch])
        .await
        .unwrap();
    std::fs::write(dir.path().join("note.md"), "ours\n").unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    assert_ne!(
        cli.exec(dir.path(), &["merge", "other"])
            .await
            .unwrap()
            .exit_code,
        0
    );
    let item = read_item(&cli, dir.path(), "note.md", "1".into())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(item).unwrap()["state"], "conflict");
    #[cfg(unix)]
    {
        let pipe = dir.path().join("pipe");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&pipe)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            read_item(&cli, dir.path(), "pipe", "1".into())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn inspection_stats_cover_collapsed_files_without_mutating_the_index() {
    use super::inspection_stats::read_stats;
    let (dir, cli) = repo().await;
    std::fs::create_dir(dir.path().join("contract")).unwrap();
    std::fs::write(dir.path().join("contract/new.md"), "a\nb").unwrap();
    let scope = || {
        serde_json::from_value(serde_json::json!({"kind": "directory", "path": "contract"}))
            .unwrap()
    };
    let initial = serde_json::to_value(
        read_stats(
            &cli,
            dir.path(),
            vec!["contract/new.md".into()],
            "unborn".into(),
            scope(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(initial["items"][0]["additions"], 2);
    assert_eq!(initial["items"][0]["deletions"], 0);
    for (path, content) in [
        ("contract/note.md", "first\nsecond\n"),
        ("contract/gone.md", "gone\n"),
        ("contract/index.md", "same\n"),
        ("contract/tab\tfile.md", "old\n"),
        ("outside.md", "before\n"),
    ] {
        std::fs::write(dir.path().join(path), content).unwrap();
    }
    commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("contract/note.md"), "staged\n").unwrap();
    ops::add(&cli, dir.path(), "contract/note.md")
        .await
        .unwrap();
    std::fs::write(
        dir.path().join("contract/note.md"),
        "first\nthird\nfourth\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("contract/index.md"), "staged\n").unwrap();
    ops::add(&cli, dir.path(), "contract/index.md")
        .await
        .unwrap();
    std::fs::write(dir.path().join("contract/index.md"), "same\n").unwrap();
    std::fs::write(dir.path().join("contract/tab\tfile.md"), "new\n").unwrap();
    std::fs::remove_file(dir.path().join("contract/gone.md")).unwrap();
    std::fs::write(dir.path().join("contract/added.md"), "a\nb").unwrap();
    std::fs::write(dir.path().join("contract/binary.bin"), [0, 1, 2]).unwrap();
    std::fs::write(dir.path().join("outside.md"), "staged outside\n").unwrap();
    ops::add(&cli, dir.path(), "outside.md").await.unwrap();
    let index = cli
        .exec(dir.path(), &["diff", "--cached"])
        .await
        .unwrap()
        .stdout;
    let paths = [
        "note.md",
        "gone.md",
        "index.md",
        "tab\tfile.md",
        "added.md",
        "binary.bin",
    ];
    let result = serde_json::to_value(
        read_stats(
            &cli,
            dir.path(),
            paths
                .iter()
                .map(|path| format!("contract/{path}"))
                .collect(),
            "closed".into(),
            scope(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(result["generation"], "closed");
    for (index, additions, deletions) in [(0, 2, 1), (1, 0, 1), (2, 0, 0), (3, 1, 1), (4, 2, 0)] {
        assert_eq!(result["items"][index]["additions"], additions);
        assert_eq!(result["items"][index]["deletions"], deletions);
    }
    assert!(result["items"][5]["additions"].is_null());
    assert_eq!(
        index,
        cli.exec(dir.path(), &["diff", "--cached"])
            .await
            .unwrap()
            .stdout
    );
    let inline_scope =
        serde_json::from_value(serde_json::json!({"kind": "repository", "path": ""})).unwrap();
    let inline = serde_json::to_value(
        read_stats(
            &cli,
            &dir.path().join("contract"),
            vec!["note.md".into()],
            "inline".into(),
            inline_scope,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(inline["items"][0]["additions"], 2);
    assert_eq!(inline["items"][0]["deletions"], 1);
}

#[tokio::test]
async fn inspection_stats_enforce_scope_size_and_child_repository_boundaries() {
    use super::inspection_stats::read_stats;
    let (dir, cli) = repo().await;
    std::fs::create_dir(dir.path().join("contract")).unwrap();
    std::fs::write(
        dir.path().join("contract/large.md"),
        vec![b'a'; 512 * 1024 + 1],
    )
    .unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("contract/large.md"), "small now\n").unwrap();
    std::fs::write(
        dir.path().join("contract/new-large.md"),
        vec![b'a'; 512 * 1024 + 1],
    )
    .unwrap();
    std::fs::create_dir(dir.path().join("contract/child")).unwrap();
    cli.exec(&dir.path().join("contract/child"), &["init"])
        .await
        .unwrap();
    std::fs::write(dir.path().join("contract/child/private.md"), "child\n").unwrap();
    let scope = || {
        serde_json::from_value(serde_json::json!({"kind": "directory", "path": "contract"}))
            .unwrap()
    };
    let result = serde_json::to_value(
        read_stats(
            &cli,
            dir.path(),
            vec![
                "contract/large.md".into(),
                "contract/new-large.md".into(),
                "contract/child/private.md".into(),
            ],
            "limits".into(),
            scope(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert!(
        result["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["additions"].is_null())
    );
    for path in ["../escape.md", "outside.md"] {
        assert!(
            read_stats(&cli, dir.path(), vec![path.into()], "scope".into(), scope())
                .await
                .is_err()
        );
    }
    assert!(
        read_stats(
            &cli,
            dir.path(),
            vec!["contract/large.md".into(); 51],
            "batch".into(),
            scope()
        )
        .await
        .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("child/private.md", dir.path().join("contract/link.md"))
            .unwrap();
        let result = serde_json::to_value(
            read_stats(
                &cli,
                dir.path(),
                vec!["contract/link.md".into()],
                "link".into(),
                scope(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert!(result["items"][0]["additions"].is_null());
    }
}

const FRONTMATTER: [&str; 3] = ["---", "title: Note", "---"];
const BODY: [&str; 6] = [
    "",
    "First paragraph.",
    "",
    "Second paragraph.",
    "",
    "Third paragraph.",
];

/// The Page with frontmatter and body lines ending in the given endings.
fn page(frontmatter: &str, body: &str, edited: bool) -> String {
    let mut text = String::new();
    for line in FRONTMATTER {
        text.push_str(line);
        text.push_str(frontmatter);
    }
    for line in BODY {
        let line = if edited && line == "Second paragraph." {
            "Second paragraph, edited."
        } else {
            line
        };
        text.push_str(line);
        text.push_str(body);
    }
    text
}

/// A repository whose local configuration and attributes leave only the line
/// ending policy of the case in effect, whatever the global configuration.
async fn line_ending_repo(
    config: &[(&str, &str)],
    attributes: &str,
) -> (tempfile::TempDir, GitCli) {
    let (dir, cli) = repo().await;
    for (key, value) in [
        ("core.autocrlf", "false"),
        ("core.eol", "lf"),
        ("core.safecrlf", "false"),
        ("core.attributesFile", ""),
    ]
    .iter()
    .chain(config)
    {
        cli.exec(dir.path(), &["config", key, value]).await.unwrap();
    }
    if !attributes.is_empty() {
        std::fs::write(dir.path().join(".gitattributes"), attributes).unwrap();
        commit_file(&cli, dir.path(), ".gitattributes")
            .await
            .unwrap();
    }
    (dir, cli)
}

fn numstat(stdout: &str) -> (usize, usize) {
    stdout
        .lines()
        .next()
        .and_then(|line| {
            let mut fields = line.split('\t');
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0))
}

/// Lines added and removed between two texts, counted by Git without any
/// conversion, as the Sheet diff compares them.
async fn changed_lines(cli: &GitCli, before: &str, after: &str) -> (usize, usize) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("before"), before).unwrap();
    std::fs::write(dir.path().join("after"), after).unwrap();
    let output = cli
        .exec(
            dir.path(),
            &[
                "-c",
                "core.autocrlf=false",
                "diff",
                "--no-index",
                "--numstat",
                "before",
                "after",
            ],
        )
        .await
        .unwrap();
    numstat(&output.stdout)
}

/// Bytes of the index and the names of every loose and packed object.
fn repository_state(
    dir: &std::path::Path,
) -> (Vec<u8>, Option<std::time::SystemTime>, Vec<String>) {
    let index = dir.join(".git/index");
    let mut objects = Vec::new();
    let mut pending = vec![dir.join(".git/objects")];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(next).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                objects.push(path.to_string_lossy().into_owned());
            }
        }
    }
    objects.sort();
    (
        std::fs::read(&index).unwrap(),
        std::fs::metadata(&index).unwrap().modified().ok(),
        objects,
    )
}

#[tokio::test]
async fn inspection_compares_the_working_file_in_repository_form_as_git_diff() {
    // (case, configuration, attributes, committed endings, Git normalizes)
    let cases: [(&str, &[(&str, &str)], &str, &str, bool); 6] = [
        ("autocrlf", &[("core.autocrlf", "true")], "", "\r\n", true),
        (
            "eol=crlf",
            // An empty context line is then printed without its space.
            &[("diff.suppressBlankEmpty", "true")],
            "*.md text eol=crlf\n",
            "\r\n",
            true,
        ),
        ("text=auto", &[], "*.md text=auto\n", "\r\n", true),
        ("stored crlf", &[], "", "\r\n", false),
        (
            "-text",
            &[("core.autocrlf", "true")],
            "*.md -text\n",
            "\r\n",
            false,
        ),
        // A blob with CR is not normalized after autocrlf is turned on.
        ("safe-crlf", &[], "", "\r\n", false),
    ];
    for (case, config, attributes, committed, normalizes) in cases {
        let (dir, cli) = line_ending_repo(config, attributes).await;
        let path = dir.path().join("note.md");
        std::fs::write(&path, page(committed, committed, false)).unwrap();
        commit_file(&cli, dir.path(), "note.md").await.unwrap();
        if case == "safe-crlf" {
            cli.exec(dir.path(), &["config", "core.autocrlf", "true"])
                .await
                .unwrap();
        }
        let blob = cli
            .exec(dir.path(), &["show", "HEAD:note.md"])
            .await
            .unwrap()
            .stdout;
        assert_eq!(blob.contains('\r'), !normalizes, "{case}");
        for (write, frontmatter, body) in [
            ("mixed", "\r\n", "\n"),
            ("crlf", "\r\n", "\r\n"),
            ("lf", "\n", "\n"),
        ] {
            for edited in [true, false] {
                let written = page(frontmatter, body, edited);
                std::fs::write(&path, &written).unwrap();
                let state = repository_state(dir.path());
                let item = serde_json::to_value(
                    read_item(&cli, dir.path(), "note.md", "1".into())
                        .await
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(state, repository_state(dir.path()), "{case} {write}");
                let label = format!("{case} {write} edited={edited}");
                assert_eq!(item["before"], blob, "{label}");
                assert_eq!(item["afterBytes"], written.len(), "{label}");
                assert_eq!(item["title"], "Note", "{label}");
                let after = item["after"].as_str().unwrap();
                let git = numstat(
                    &cli.exec(
                        dir.path(),
                        &["diff", "--numstat", "--no-renames", "HEAD", "--", "note.md"],
                    )
                    .await
                    .unwrap()
                    .stdout,
                );
                let shown = changed_lines(&cli, &blob, after).await;
                assert_eq!(shown, git, "{label}");
                if normalizes {
                    assert_eq!(shown, if edited { (1, 1) } else { (0, 0) }, "{label}");
                    assert_eq!(
                        item["state"],
                        if edited { "text" } else { "no_content_diff" },
                        "{label}"
                    );
                } else if write != "crlf" {
                    // A real change of endings that Git commits stays visible.
                    assert_ne!(item["state"], "no_content_diff", "{label}");
                    assert!(shown.0 > 1, "{label}");
                }
            }
        }
    }
}

#[tokio::test]
async fn inspection_keeps_line_endings_at_the_end_of_the_file_as_git() {
    let (dir, cli) = line_ending_repo(&[("core.autocrlf", "true")], "").await;
    let path = dir.path().join("note.md");
    for (committed, written, after) in [
        ("a\r\nb", "a\r\nc", "a\nc"),
        ("a\r\nb\r\n", "a\r\nb", "a\nb"),
        ("a\r\nb", "a\r\nb\r\n", "a\nb\n"),
        ("a\r\nb", "x\r\na\r\nb", "x\na\nb"),
    ] {
        std::fs::write(&path, committed).unwrap();
        commit_file(&cli, dir.path(), "note.md").await.unwrap();
        std::fs::write(&path, written).unwrap();
        let item = serde_json::to_value(
            read_item(&cli, dir.path(), "note.md", "1".into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            item["before"],
            committed.replace("\r\n", "\n"),
            "{written:?}"
        );
        assert_eq!(item["after"], after, "{written:?}");
    }
}

#[tokio::test]
async fn inspection_diff_never_runs_a_clean_driver_and_compares_its_path_raw() {
    let (dir, cli) = line_ending_repo(
        &[
            ("core.autocrlf", "true"),
            ("filter.probe.clean", "echo run >> filter-runs && cat"),
            ("filter.probe.smudge", "cat"),
        ],
        "*.md filter=probe\n",
    )
    .await;
    let path = dir.path().join("note.md");
    std::fs::write(&path, "a\r\nb\r\n").unwrap();
    commit_file(&cli, dir.path(), "note.md").await.unwrap();
    let runs = dir.path().join("filter-runs");
    std::fs::write(&path, "a\r\nc\r\n").unwrap();
    // The item status the inspection already reads hashes a stat-dirty file
    // through the driver; the repository form adds no run of its own.
    std::fs::remove_file(&runs).unwrap();
    let status = cli
        .exec(
            dir.path(),
            &[
                "--literal-pathspecs",
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=no",
                "--ignore-submodules=dirty",
                "--",
                ".",
            ],
        )
        .await
        .unwrap();
    assert_eq!(status.exit_code, 0);
    let status_runs = std::fs::read_to_string(&runs).unwrap_or_default();
    std::fs::remove_file(&runs).ok();
    let state = repository_state(dir.path());
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "1".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&runs).unwrap_or_default(),
        status_runs
    );
    assert_eq!(state, repository_state(dir.path()));
    assert_eq!(item["before"], "a\nb\n");
    assert_eq!(item["after"], "a\r\nc\r\n");
}

#[tokio::test]
async fn inspection_keeps_new_deleted_renamed_and_oversized_sources_under_autocrlf() {
    let (dir, cli) = line_ending_repo(&[("core.autocrlf", "true")], "").await;
    for name in ["gone.md", "moved.md"] {
        std::fs::write(dir.path().join(name), "base\r\n").unwrap();
    }
    std::fs::write(dir.path().join("large.md"), "a\r\n".repeat(200 * 1024)).unwrap();
    std::fs::write(dir.path().join("grows.md"), "a\r\n").unwrap();
    commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("new.md"), "a\r\nb").unwrap();
    std::fs::remove_file(dir.path().join("gone.md")).unwrap();
    cli.exec(dir.path(), &["mv", "moved.md", "renamed.md"])
        .await
        .unwrap();
    std::fs::write(dir.path().join("renamed.md"), "base\r\nmore\r\n").unwrap();
    std::fs::write(dir.path().join("large.md"), "b\r\n".repeat(200 * 1024)).unwrap();
    std::fs::write(dir.path().join("grows.md"), "a\r\n".repeat(200 * 1024)).unwrap();
    let read = |name: &'static str| {
        let cli = cli.clone();
        let root = dir.path().to_path_buf();
        async move {
            serde_json::to_value(read_item(&cli, &root, name, "1".into()).await.unwrap()).unwrap()
        }
    };
    let new = read("new.md").await;
    assert_eq!(
        (new["before"].as_str(), new["after"].as_str()),
        (Some(""), Some("a\r\nb"))
    );
    let gone = read("gone.md").await;
    assert_eq!(
        (gone["before"].as_str(), gone["after"].as_str()),
        (Some("base\n"), Some(""))
    );
    let renamed = read("renamed.md").await;
    assert_eq!(renamed["previousPath"], "moved.md");
    assert_eq!(renamed["after"], "base\r\nmore\r\n");
    for name in ["large.md", "grows.md"] {
        let item = read(name).await;
        assert_eq!(item["state"], "truncated", "{name}");
        assert!(item["after"].is_null(), "{name}");
    }
}
