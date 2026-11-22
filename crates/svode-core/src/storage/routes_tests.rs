use std::collections::BTreeSet;
use std::fs;

use tempfile::TempDir;

use super::*;

fn rules(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|path| path.to_string()).collect()
}

#[test]
fn an_inline_space_delete_drops_the_rules_of_its_repository_relative_paths() {
    let tmp = TempDir::new().unwrap();
    let project = tmp.path();
    let space = project.join("eng");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&space).unwrap();
    let gitignore = project.join(".gitignore");
    let before = rewrite_managed_path_block(
        "node_modules/\n",
        LOCAL_PATHS_START,
        LOCAL_PATHS_END,
        &rules(&["Notes/scan.bin", "eng/Notes/scan.bin", "eng/Notes.bin"]),
        false,
    );
    fs::write(&gitignore, &before).unwrap();

    let dropped =
        drop_managed_attachment_local_routes(space.to_str().unwrap(), project.to_str(), "Notes")
            .unwrap()
            .expect("a rule of the deleted tree");

    assert_eq!(dropped.path(), gitignore);
    let after = fs::read_to_string(&gitignore).unwrap();
    assert_eq!(
        parse_managed_paths(&after, LOCAL_PATHS_START, LOCAL_PATHS_END).unwrap(),
        rules(&["Notes/scan.bin", "eng/Notes.bin"])
    );
    assert!(after.starts_with("node_modules/\n"));

    dropped.restore().unwrap();
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);
}

#[test]
fn a_space_repository_delete_without_a_ruled_path_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join(".git")).unwrap();
    let space = space.to_str().unwrap();

    // No `.gitignore` at all.
    assert!(
        drop_managed_attachment_local_routes(space, None, "Notes")
            .unwrap()
            .is_none()
    );
    assert!(!tmp.path().join(".gitignore").exists());

    let gitignore = tmp.path().join(".gitignore");
    let before = rewrite_managed_path_block(
        "",
        LOCAL_PATHS_START,
        LOCAL_PATHS_END,
        &rules(&["Other/scan.bin"]),
        false,
    );
    fs::write(&gitignore, &before).unwrap();
    assert!(
        drop_managed_attachment_local_routes(space, Some("/elsewhere"), "Notes")
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);

    // The only rule gone removes the generated-only file.
    let dropped = drop_managed_attachment_local_routes(space, None, "Other")
        .unwrap()
        .expect("the ruled path");
    assert!(!gitignore.exists());
    dropped.restore().unwrap();
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);
}

const LFS_ATTRIBUTES: &str = " filter=lfs diff=lfs merge=lfs -text";

/// DF-380 R1: a path without a space, a tab, `"` or a control character
/// keeps its unquoted rule byte for byte.
#[test]
fn an_lfs_path_rule_without_whitespace_keeps_its_unquoted_form() {
    for (path, pattern) in [
        ("Topic/plain.mov", "Topic/plain.mov"),
        ("Topic/кириллица.mov", "Topic/кириллица.mov"),
        ("Topic/br[1].mov", r"Topic/br\[1\].mov"),
        ("Topic/star*?.mov", r"Topic/star\*\?.mov"),
        ("Topic/!bang.mov", r"Topic/\!bang.mov"),
        ("#hash.mov", r"\#hash.mov"),
        (r"Topic/back\slash.mov", r"Topic/back\\slash.mov"),
    ] {
        assert_eq!(lfs_path_rule(path), format!("{pattern}{LFS_ATTRIBUTES}"));
    }
    assert_eq!(
        rewrite_managed_path_block(
            "",
            LFS_PATHS_START,
            LFS_PATHS_END,
            &rules(&["a/b.mov"]),
            true
        ),
        "# svode:assets-lfs-paths:start\n# svode:path \"a/b.mov\"\na/b.mov filter=lfs diff=lfs merge=lfs -text\n# svode:assets-lfs-paths:end\n"
    );
}

/// DF-380 R1: a space, a tab, `"` or a control character puts the escaped
/// pattern in C-style double quotes; non-ASCII stays UTF-8.
#[test]
fn an_lfs_path_rule_with_whitespace_quotes_the_escaped_pattern() {
    for (path, pattern) in [
        (
            "Topic/Запись экрана 2026-10-07 в 12.06.16.mov",
            r#""Topic/Запись\\ экрана\\ 2026-10-07\\ в\\ 12.06.16.mov""#,
        ),
        ("Topic/tab\tname.mov", r#""Topic/tab\\\tname.mov""#),
        ("Topic/quote\"name.mov", r#""Topic/quote\"name.mov""#),
        (
            r"Topic/back\slash x.mov",
            r#""Topic/back\\\\slash\\ x.mov""#,
        ),
        ("Topic/br[1] x.mov", r#""Topic/br\\[1\\]\\ x.mov""#),
        ("Topic/star* ?.mov", r#""Topic/star\\*\\ \\?.mov""#),
        ("Topic/!bang x.mov", r#""Topic/\\!bang\\ x.mov""#),
        ("#hash x.mov", r#""\\#hash\\ x.mov""#),
        ("Topic/new\nline.mov", r#""Topic/new\nline.mov""#),
        (
            "Topic/ctrl\u{1}\r\u{7f}.mov",
            r#""Topic/ctrl\001\015\177.mov""#,
        ),
    ] {
        assert_eq!(
            lfs_path_rule(path),
            format!("{pattern}{LFS_ATTRIBUTES}"),
            "{path:?}"
        );
    }
}

/// DF-380 R4: exact local rules keep the backslash escaping and the leading
/// `/`, with or without whitespace in the path.
#[test]
fn exact_local_rules_keep_their_escaped_anchored_form() {
    assert_eq!(
        rewrite_managed_path_block(
            "",
            LOCAL_PATHS_START,
            LOCAL_PATHS_END,
            &rules(&["My Notes/scan [1].bin"]),
            false,
        ),
        "# svode:assets-local-paths:start\n# svode:path \"My Notes/scan [1].bin\"\n/My\\ Notes/scan\\ \\[1\\].bin\n# svode:assets-local-paths:end\n"
    );
}

/// DF-380 R1: Git applies every written rule to exactly its path, and the
/// git-lfs parser reads the file.
#[tokio::test]
async fn git_applies_each_exact_lfs_rule_to_exactly_its_path() {
    use crate::git::cli::GitCli;
    use crate::storage::policy::check_lfs_filters;

    let Ok(cli) = GitCli::detect() else {
        return;
    };
    let temp = TempDir::new().unwrap();
    let repo = temp.path();
    let init = cli.exec(repo, &["init", "-q"]).await.unwrap();
    assert_eq!(init.exit_code, 0, "{}", init.stderr);
    let ruled = [
        "Topic/Запись экрана 2026-10-07 в 12.06.16.mov",
        "Topic/back/slash x.mov",
        "Topic/br[1] x.mov",
        "Topic/!bang x.mov",
        "Topic/#hash x.mov",
        "#root x.mov",
        "Topic/кириллица.mov",
        "Topic/plain.mov",
        // The string-format test covers these characters on every OS.
        // Git for Windows treats a backslash as a path separator.
        #[cfg(not(windows))]
        "Topic/tab\tname.mov",
        #[cfg(not(windows))]
        "Topic/quote\"name x.mov",
        #[cfg(not(windows))]
        r"Topic/back\slash x.mov",
        #[cfg(not(windows))]
        "Topic/star* ?.mov",
        #[cfg(not(windows))]
        "Topic/new\nline.mov",
        #[cfg(not(windows))]
        "Topic/ctrl\u{1}x.mov",
    ];
    let neighbours = [
        "Topic/Запись",
        "Topic/tab name.mov",
        "Topic/backslash x.mov",
        "Topic/br1 x.mov",
        "Topic/brx x.mov",
        "Topic/starX Y.mov",
        "Topic/!bang  x.mov",
        "Topic/newline.mov",
        "Topic/plain.mov.bak",
    ];
    fs::write(
        repo.join(".gitattributes"),
        rewrite_managed_path_block(
            "*.custom merge=ours\n",
            LFS_PATHS_START,
            LFS_PATHS_END,
            &rules(&ruled),
            true,
        ),
    )
    .unwrap();

    let paths = ruled
        .iter()
        .chain(&neighbours)
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    let checks = check_lfs_filters(&cli, repo, &paths).await.unwrap();
    for check in &checks {
        let expected = if ruled.contains(&check.path.as_str()) {
            "lfs"
        } else {
            "unspecified"
        };
        assert_eq!(check.value, expected, "{:?}", check.path);
    }
    assert_eq!(checks.len(), paths.len());

    if cli.lfs_available() {
        let track = cli.exec(repo, &["lfs", "track"]).await.unwrap();
        assert_eq!(track.exit_code, 0, "{}", track.stderr);
        assert!(track.stderr.trim().is_empty(), "{}", track.stderr);
    }
}
