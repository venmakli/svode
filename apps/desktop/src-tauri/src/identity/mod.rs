pub mod commands;

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::AppError;
use crate::git::cli::GitCli;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalIdentityResult {
    pub global: Option<GitIdentity>,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentityResult {
    pub local: Option<GitIdentity>,
    pub effective: Option<GitIdentity>,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutPreviewEntry {
    pub space_path: String,
    pub space_name: String,
    pub current_local: Option<GitIdentity>,
    pub will_replace: bool,
}

fn email_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").expect("valid email regex"))
}

fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::IdentityInvalid("name"));
    }
    Ok(trimmed.to_string())
}

fn validate_email(email: &str) -> Result<String, AppError> {
    let trimmed = email.trim();
    if !email_regex().is_match(trimmed) {
        return Err(AppError::IdentityInvalid("email"));
    }
    Ok(trimmed.to_string())
}

pub async fn get_global_identity(cli: &GitCli) -> Result<Option<GitIdentity>, AppError> {
    let name_out = cli
        .exec_no_dir(&["config", "--global", "--get", "user.name"])
        .await?;
    let email_out = cli
        .exec_no_dir(&["config", "--global", "--get", "user.email"])
        .await?;
    if name_out.exit_code != 0 || email_out.exit_code != 0 {
        return Ok(None);
    }
    let name = name_out.stdout.trim().to_string();
    let email = email_out.stdout.trim().to_string();
    if name.is_empty() || email.is_empty() {
        return Ok(None);
    }
    Ok(Some(GitIdentity { name, email }))
}

pub async fn set_global_identity(
    cli: &GitCli,
    name: &str,
    email: &str,
) -> Result<(), AppError> {
    let name = validate_name(name)?;
    let email = validate_email(email)?;
    let out = cli
        .exec_no_dir(&["config", "--global", "user.name", &name])
        .await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git config --global user.name failed: {}",
            out.stderr.trim()
        )));
    }
    let out = cli
        .exec_no_dir(&["config", "--global", "user.email", &email])
        .await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git config --global user.email failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(())
}

pub async fn get_local_identity(
    cli: &GitCli,
    repo_path: &Path,
) -> Result<Option<GitIdentity>, AppError> {
    let name_out = cli
        .exec(repo_path, &["config", "--local", "--get", "user.name"])
        .await?;
    let email_out = cli
        .exec(repo_path, &["config", "--local", "--get", "user.email"])
        .await?;
    if name_out.exit_code != 0 || email_out.exit_code != 0 {
        return Ok(None);
    }
    let name = name_out.stdout.trim().to_string();
    let email = email_out.stdout.trim().to_string();
    if name.is_empty() || email.is_empty() {
        return Ok(None);
    }
    Ok(Some(GitIdentity { name, email }))
}

pub async fn set_local_identity(
    cli: &GitCli,
    repo_path: &Path,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<(), AppError> {
    match (name, email) {
        (None, None) => {
            // Unset both. Git returns exit code 5 when the variable is not
            // set; treat any failure here as best-effort and ignore — the
            // post-condition is "not set", which is already satisfied.
            let _ = cli
                .exec(repo_path, &["config", "--local", "--unset", "user.name"])
                .await;
            let _ = cli
                .exec(repo_path, &["config", "--local", "--unset", "user.email"])
                .await;
            Ok(())
        }
        (Some(n), Some(e)) => {
            let n = validate_name(n)?;
            let e = validate_email(e)?;
            let out = cli
                .exec(repo_path, &["config", "--local", "user.name", &n])
                .await?;
            if out.exit_code != 0 {
                return Err(AppError::GitCommandFailed(format!(
                    "git config --local user.name failed: {}",
                    out.stderr.trim()
                )));
            }
            let out = cli
                .exec(repo_path, &["config", "--local", "user.email", &e])
                .await?;
            if out.exit_code != 0 {
                return Err(AppError::GitCommandFailed(format!(
                    "git config --local user.email failed: {}",
                    out.stderr.trim()
                )));
            }
            Ok(())
        }
        _ => Err(AppError::IdentityInvalid("both_required")),
    }
}

pub async fn get_effective_identity(
    cli: &GitCli,
    repo_path: &Path,
) -> Result<RepoIdentityResult, AppError> {
    let name_out = cli.exec(repo_path, &["config", "--get", "user.name"]).await?;
    let email_out = cli
        .exec(repo_path, &["config", "--get", "user.email"])
        .await?;

    let local = get_local_identity(cli, repo_path).await?;

    if name_out.exit_code != 0 || email_out.exit_code != 0 {
        return Ok(RepoIdentityResult {
            local,
            effective: None,
            source: "missing",
        });
    }
    let name = name_out.stdout.trim().to_string();
    let email = email_out.stdout.trim().to_string();
    if name.is_empty() || email.is_empty() {
        return Ok(RepoIdentityResult {
            local,
            effective: None,
            source: "missing",
        });
    }

    let source = if local.is_some() { "local" } else { "global" };
    Ok(RepoIdentityResult {
        local,
        effective: Some(GitIdentity { name, email }),
        source,
    })
}

/// Copy local identity from `root_path` into `new_space_path`. Called after
/// `git init` for new independent/submodule spaces, and after clone /
/// `submodule update --init`. No-op when the root has no local identity —
/// the global config will apply via natural git precedence.
pub async fn scaffold_space_git_identity(
    cli: &GitCli,
    new_space_path: &Path,
    root_path: &Path,
) -> Result<(), AppError> {
    if let Some(id) = get_local_identity(cli, root_path).await? {
        set_local_identity(cli, new_space_path, Some(&id.name), Some(&id.email)).await?;
    }
    Ok(())
}

/// Apply identity to root + N target_spaces. Stops at the first failure and
/// returns an error annotated with the failing path.
pub async fn apply_identity_to_project(
    cli: &GitCli,
    root_path: &Path,
    name: Option<&str>,
    email: Option<&str>,
    target_spaces: &[String],
) -> Result<(), AppError> {
    set_local_identity(cli, root_path, name, email)
        .await
        .map_err(|e| AppError::General(format!(
            "identity write failed for root {}: {e}",
            root_path.display()
        )))?;
    for sp in target_spaces {
        let p = Path::new(sp);
        set_local_identity(cli, p, name, email)
            .await
            .map_err(|e| AppError::General(format!("identity write failed for {sp}: {e}")))?;
    }
    Ok(())
}
