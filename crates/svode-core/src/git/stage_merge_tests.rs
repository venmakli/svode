use super::*;
use crate::git::service_merge::index_conflicts;
use std::path::PathBuf;
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8(out.stdout).unwrap())
}

fn write(repo: &Path, files: &[(&str, &str)]) {
    for (file, content) in files {
        let path = repo.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}

/// A repository whose merge of the branch `theirs` into `main` stopped at
/// conflicts: `base` committed first, then the edits of each side.
pub(crate) struct Stand {
    _temp: tempfile::TempDir,
    pub(crate) repo: PathBuf,
    pub(crate) cli: GitCli,
}

impl Stand {
    /// `attributes` go to `.git/info/attributes` before the merge.
    pub(crate) async fn merge(
        attributes: &str,
        base: &[(&str, &str)],
        theirs: &[(&str, &str)],
        ours: &[(&str, &str)],
    ) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            git(&repo, args).unwrap_or_else(|| panic!("git {args:?} failed"));
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Fixture"]);
        run(&["config", "user.email", "fixture@example.test"]);
        write(&repo, &[(".git/info/attributes", attributes)]);
        write(&repo, &[("README.md", "# Project\n")]);
        write(&repo, base);
        run(&["add", "-A"]);
        run(&["commit", "-qm", "base"]);
        run(&["checkout", "-qb", "theirs"]);
        write(&repo, theirs);
        run(&["add", "-A"]);
        run(&["commit", "-qm", "theirs"]);
        run(&["checkout", "-q", "main"]);
        write(&repo, ours);
        run(&["add", "-A"]);
        run(&["commit", "-qm", "ours"]);
        assert!(git(&repo, &["merge", "theirs"]).is_none(), "no conflict");
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
        )
        .unwrap();
        let cli = GitCli::for_test(wrapper);
        cli.refresh_version().await;
        Self {
            _temp: temp,
            repo,
            cli,
        }
    }

    pub(crate) fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.repo.join(file)).unwrap()
    }

    pub(crate) fn write(&self, file: &str, content: &str) {
        write(&self.repo, &[(file, content)]);
    }

    async fn conflict(&self, path: &str) -> ConflictedPath {
        index_conflicts(&self.cli, &self.repo)
            .await
            .unwrap()
            .into_iter()
            .find(|conflict| conflict.path == path)
            .unwrap_or_else(|| panic!("{path} is not in conflict"))
    }

    async fn merged(&self, path: &str, size: usize, style: ConflictStyle) -> Option<String> {
        let conflict = self.conflict(path).await;
        merge_stages(&self.cli, &self.repo, &conflict, size, style)
            .await
            .unwrap()
            .map(|merged| String::from_utf8(merged).unwrap())
    }
}

/// The text with the labels of its marker lines dropped.
fn without_labels(text: &str) -> String {
    text.lines()
        .map(|line| match line.split_once(' ') {
            Some((marker, _))
                if marker.len() >= 7
                    && marker.chars().all(|c| c == marker.chars().next().unwrap())
                    && matches!(marker.chars().next(), Some('<' | '|' | '>')) =>
            {
                marker
            }
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const PRICES: &str = "---\ntitle: Тарифы\nprice: 10\ncurrency: \"USD\"\nnote: |\n  Цена без налога.\n  Пересматривается раз в квартал.\n---\nТекст страницы тарифов без конфликта.\n";

async fn prices(attributes: &str) -> Stand {
    Stand::merge(
        attributes,
        &[("Тарифы.md", PRICES)],
        &[(
            "Тарифы.md",
            &PRICES
                .replace(
                    "price: 10\ncurrency: \"USD\"",
                    "price: 12\ncurrency: \"EUR\"",
                )
                .replace("  Цена без налога.\n", "  Цена с налогом.\n"),
        )],
        &[(
            "Тарифы.md",
            &PRICES
                .replace(
                    "price: 10\ncurrency: \"USD\"",
                    "price: 11\ncurrency: \"USD\"  # базовая",
                )
                .replace("  Цена без налога.\n", "  Цена без налога, без скидок.\n"),
        )],
    )
    .await
}

#[tokio::test]
async fn the_merge_of_the_stages_is_the_file_git_wrote() {
    let stand = prices("").await;
    let written = stand.read("Тарифы.md");
    assert!(written.contains("<<<<<<< HEAD\nprice: 11\n"), "{written}");
    let merged = stand
        .merged("Тарифы.md", 7, ConflictStyle::Merge)
        .await
        .unwrap();
    assert_eq!(without_labels(&merged), without_labels(&written));
    // The working file takes no part.
    stand.write("Тарифы.md", PRICES);
    assert_eq!(
        stand.merged("Тарифы.md", 7, ConflictStyle::Merge).await,
        Some(merged)
    );
}

#[tokio::test]
async fn the_style_and_the_marker_size_are_the_requested_ones() {
    let stand = prices("*.md conflict-marker-size=10\n").await;
    assert!(stand.read("Тарифы.md").contains("<<<<<<<<<< HEAD\n"));
    let diff3 = stand
        .merged("Тарифы.md", 10, ConflictStyle::Diff3)
        .await
        .unwrap();
    assert!(
        diff3.contains("<<<<<<<<<< ours\nprice: 11\n")
            && diff3.contains("|||||||||| base\nprice: 10\ncurrency: \"USD\"\n")
            && diff3.contains("==========\nprice: 12\n"),
        "{diff3}"
    );
    // The style of the config of the repository does not win.
    git(&stand.repo, &["config", "merge.conflictStyle", "diff3"]).unwrap();
    let merge = stand
        .merged("Тарифы.md", 10, ConflictStyle::Merge)
        .await
        .unwrap();
    assert!(!merge.contains("||||||||||"), "{merge}");
    assert!(merge.contains("==========\nprice: 12\n"), "{merge}");
}

#[tokio::test]
async fn added_on_both_sides_merges_over_an_empty_base() {
    let stand = Stand::merge(
        "",
        &[],
        &[("new.md", "---\ntitle: B\n---\nSame\n")],
        &[("new.md", "---\ntitle: A\n---\nSame\n")],
    )
    .await;
    let conflict = stand.conflict("new.md").await;
    let texts = read_stages(&stand.cli, &stand.repo, &conflict)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(texts.base, None);
    assert_eq!(texts.ours, b"---\ntitle: A\n---\nSame\n");
    let merged = merge_texts(&stand.cli, &stand.repo, &texts, 7, ConflictStyle::Merge)
        .await
        .unwrap();
    assert_eq!(
        without_labels(&String::from_utf8(merged).unwrap()),
        without_labels(&stand.read("new.md"))
    );
}

#[tokio::test]
async fn a_side_without_the_path_or_a_file_gives_no_merge() {
    let stand = prices("").await;
    let conflict = stand.conflict("Тарифы.md").await;
    let deleted = ConflictedPath {
        ours: None,
        ..conflict.clone()
    };
    let link = ConflictedPath {
        theirs: conflict.theirs.clone().map(|stage| StageEntry {
            mode: "120000".into(),
            ..stage
        }),
        ..conflict
    };
    for conflict in [deleted, link] {
        assert_eq!(
            merge_stages(&stand.cli, &stand.repo, &conflict, 7, ConflictStyle::Merge)
                .await
                .unwrap(),
            None
        );
    }
}
