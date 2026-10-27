use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::repo_path::{RootMode, normalize_repo_relative};
use svode_core::git::cli::GitCli;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkFixSuggestion {
    pub path: String,
    pub label: String,
    pub reason: String,
}

pub(crate) async fn suggestions(
    cli: Option<&GitCli>,
    space_dir: &Path,
    broken_path: &str,
) -> Result<Vec<LinkFixSuggestion>, AppError> {
    let mut suggestions = Vec::new();
    if let Some(cli) = cli
        && let Some((path, reason)) = git_rename_suggestion(cli, space_dir, broken_path).await
    {
        suggestions.push(LinkFixSuggestion {
            label: label_for_path(&path),
            path,
            reason,
        });
    }

    for path in similar_path_suggestions(space_dir, broken_path)? {
        if suggestions.iter().any(|suggestion| suggestion.path == path) {
            continue;
        }
        suggestions.push(LinkFixSuggestion {
            label: label_for_path(&path),
            path,
            reason: "similar name".to_string(),
        });
        if suggestions.len() >= 3 {
            break;
        }
    }

    Ok(suggestions)
}

async fn git_rename_suggestion(
    cli: &GitCli,
    space_dir: &Path,
    broken_path: &str,
) -> Option<(String, String)> {
    let output = cli
        .exec(
            space_dir,
            &[
                "log",
                // Paths of the target Space, also when it is a folder of an
                // enclosing repository.
                "--relative",
                "--diff-filter=R",
                "--name-status",
                "-z",
                "--pretty=format:%ct%x00",
                "--all",
                "--",
                "*.md",
            ],
        )
        .await
        .ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let (path, ts) = parse_git_rename_suggestion_z(&output.stdout, broken_path)?;
    let days = chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| (chrono::Utc::now() - dt).num_days().max(0))
        .unwrap_or(0);
    Some((path, format!("renamed {days} days ago")))
}

fn parse_git_rename_suggestion_z(stdout: &str, broken_path: &str) -> Option<(String, i64)> {
    let broken_path = normalize_repo_relative(broken_path, RootMode::Reject).ok()?;
    let mut current_ts: Option<i64> = None;
    let mut tokens = stdout
        .split('\0')
        .map(|token| token.trim_matches('\n'))
        .filter(|token| !token.is_empty());

    while let Some(token) = tokens.next() {
        if let Ok(ts) = token.trim().parse::<i64>() {
            current_ts = Some(ts);
            continue;
        }
        if !token.starts_with('R') {
            continue;
        }
        let old_path = tokens.next()?;
        let new_path = tokens.next()?;
        let old_path = normalize_repo_relative(old_path, RootMode::Reject).ok()?;
        if old_path == broken_path {
            let new_path = normalize_repo_relative(new_path, RootMode::Reject).ok()?;
            return Some((new_path, current_ts.unwrap_or(0)));
        }
    }
    None
}

fn similar_path_suggestions(space_dir: &Path, broken_path: &str) -> Result<Vec<String>, AppError> {
    let broken_stem = Path::new(broken_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut candidates = Vec::new();
    for file in svode_core::index::backlinks::collect_md_files(space_dir, &[])? {
        let rel = crate::repo_path::repo_relative_from_base(space_dir, &file, RootMode::Reject)?;
        let stem = Path::new(&rel)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mut score = levenshtein(&broken_stem, &stem) as i64;
        if stem.starts_with(&broken_stem) || broken_stem.starts_with(&stem) {
            score -= 3;
        }
        if stem.ends_with(&broken_stem) || broken_stem.ends_with(&stem) {
            score -= 2;
        }
        candidates.push((score, rel));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(candidates.into_iter().take(3).map(|(_, rel)| rel).collect())
}

fn label_for_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(path)
        .replace(['-', '_'], " ")
}

fn levenshtein(a: &str, b: &str) -> usize {
    if a.is_empty() {
        return b.chars().count();
    }
    if b.is_empty() {
        return a.chars().count();
    }
    let b_chars: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b_chars.len()).collect();
    let mut curr = vec![0; b_chars.len() + 1];
    for (i, ca) in a.chars().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b_chars.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b_chars.len()]
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use super::{LinkFixSuggestion, parse_git_rename_suggestion_z, suggestions};
    use svode_core::git::cli::GitCli;

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.name", "Fixture"]);
        git(dir, &["config", "user.email", "fixture@example.test"]);
    }

    fn write(dir: &Path, path: &str, body: &str) {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
    }

    /// Commits `renames` (old → new, relative to `repo`) after committing the old files.
    fn commit_renames(repo: &Path, renames: &[(&str, &str)]) {
        for (old, _) in renames {
            write(repo, old, &format!("# {old}\n"));
        }
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-q", "-m", "add"]);
        for (old, new) in renames {
            if let Some(parent) = Path::new(new).parent() {
                std::fs::create_dir_all(repo.join(parent)).unwrap();
            }
            git(repo, &["mv", "--", old, new]);
        }
        git(repo, &["commit", "-q", "-m", "rename"]);
    }

    async fn suggested(space: &Path, broken: &str) -> Vec<(String, String)> {
        let cli = GitCli::detect().expect("git CLI");
        suggestions(Some(&cli), space, broken)
            .await
            .unwrap()
            .into_iter()
            .map(|LinkFixSuggestion { path, reason, .. }| (path, reason))
            .collect()
    }

    fn renamed(path: &str) -> (String, String) {
        (path.to_string(), "renamed 0 days ago".to_string())
    }

    #[tokio::test]
    async fn rename_suggestions_use_paths_of_the_target_space() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init(&project);
        commit_renames(
            &project,
            &[
                ("root-old.md", "root-new.md"),
                ("inline/old.md", "inline/new.md"),
                ("inline/sub/deep-old.md", "inline/sub/deep-new.md"),
                ("inline/старое имя.md", "inline/новое имя.md"),
            ],
        );
        let inline = project.join("inline");

        // Inline Space: a folder of the project repository.
        let found = suggested(&inline, "old.md").await;
        assert_eq!(found[0], renamed("new.md"));
        assert_eq!(
            found.iter().filter(|(path, _)| path == "new.md").count(),
            1,
            "{found:?}"
        );
        assert_eq!(
            suggested(&inline, "sub/deep-old.md").await[0],
            renamed("sub/deep-new.md")
        );
        assert_eq!(
            suggested(&inline, "старое имя.md").await[0],
            renamed("новое имя.md")
        );
        assert!(
            !suggested(&inline, "root-old.md")
                .await
                .iter()
                .any(|(_, reason)| reason.starts_with("renamed")),
        );

        // Root Space: as before, and a rename in the inline Space is not its path.
        assert_eq!(
            suggested(&project, "root-old.md").await[0],
            renamed("root-new.md")
        );
        assert!(
            !suggested(&project, "old.md")
                .await
                .iter()
                .any(|(_, reason)| reason.starts_with("renamed")),
        );
    }

    #[tokio::test]
    async fn rename_suggestions_of_spaces_with_their_own_repository() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init(&project);
        write(&project, "readme.md", "# Project\n");
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "project"]);

        // Independent Space: its own repository inside the project folder.
        let independent = project.join("independent");
        init(&independent);
        commit_renames(&independent, &[("docs/old.md", "docs/new.md")]);
        assert_eq!(
            suggested(&independent, "docs/old.md").await[0],
            renamed("docs/new.md")
        );

        // Submodule Space.
        let source = temp.path().join("source");
        init(&source);
        commit_renames(&source, &[("old.md", "new.md")]);
        git(
            &project,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                source.to_str().unwrap(),
                "module",
            ],
        );
        assert_eq!(
            suggested(&project.join("module"), "old.md").await[0],
            renamed("new.md")
        );
    }

    #[test]
    fn parses_git_rename_suggestion_z_with_spaces_and_cyrillic() {
        let output = concat!(
            "1710000000\0",
            "R100\0docs/старое имя.md\0docs/new name.md\0",
        );

        let parsed = parse_git_rename_suggestion_z(output, "docs/старое имя.md").unwrap();

        assert_eq!(parsed, ("docs/new name.md".to_string(), 1710000000));
    }
}
