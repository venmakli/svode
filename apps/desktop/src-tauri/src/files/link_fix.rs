use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::git::cli::GitCli;
use crate::repo_path::{RootMode, normalize_repo_relative};

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
    for file in super::backlinks::collect_md_files(space_dir, &[])? {
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
    use super::parse_git_rename_suggestion_z;

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
