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
pub struct IdentityFieldSources {
    pub name: &'static str,
    pub email: &'static str,
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
    pub local_name: Option<String>,
    pub local_email: Option<String>,
    pub effective: Option<GitIdentity>,
    pub field_sources: IdentityFieldSources,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutPreviewEntry {
    pub space_path: String,
    pub space_name: String,
    pub current_local: Option<GitIdentity>,
    pub current_effective: Option<GitIdentity>,
    pub source: &'static str,
    pub field_sources: IdentityFieldSources,
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

pub async fn set_global_identity(cli: &GitCli, name: &str, email: &str) -> Result<(), AppError> {
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
    let (name, email) = get_local_identity_fields(cli, repo_path).await?;
    match (name, email) {
        (Some(name), Some(email)) => Ok(Some(GitIdentity { name, email })),
        _ => Ok(None),
    }
}

pub async fn get_local_identity_fields(
    cli: &GitCli,
    repo_path: &Path,
) -> Result<(Option<String>, Option<String>), AppError> {
    let name_out = cli
        .exec(repo_path, &["config", "--local", "--get", "user.name"])
        .await?;
    let email_out = cli
        .exec(repo_path, &["config", "--local", "--get", "user.email"])
        .await?;
    let name = if name_out.exit_code == 0 {
        let value = name_out.stdout.trim().to_string();
        (!value.is_empty()).then_some(value)
    } else {
        None
    };
    let email = if email_out.exit_code == 0 {
        let value = email_out.stdout.trim().to_string();
        (!value.is_empty()).then_some(value)
    } else {
        None
    };
    Ok((name, email))
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
    let name_out = cli
        .exec(repo_path, &["config", "--get", "user.name"])
        .await?;
    let email_out = cli
        .exec(repo_path, &["config", "--get", "user.email"])
        .await?;

    let (local_name, local_email) = get_local_identity_fields(cli, repo_path).await?;
    let local = match (&local_name, &local_email) {
        (Some(name), Some(email)) => Some(GitIdentity {
            name: name.clone(),
            email: email.clone(),
        }),
        _ => None,
    };

    if name_out.exit_code != 0 || email_out.exit_code != 0 {
        let field_sources = IdentityFieldSources {
            name: if local_name.is_some() {
                "local"
            } else {
                "missing"
            },
            email: if local_email.is_some() {
                "local"
            } else {
                "missing"
            },
        };
        let source = if local_name.is_some() || local_email.is_some() {
            "partial"
        } else {
            "missing"
        };
        return Ok(RepoIdentityResult {
            local,
            local_name,
            local_email,
            effective: None,
            field_sources,
            source,
        });
    }
    let name = name_out.stdout.trim().to_string();
    let email = email_out.stdout.trim().to_string();
    if name.is_empty() || email.is_empty() {
        let field_sources = IdentityFieldSources {
            name: if local_name.is_some() {
                "local"
            } else {
                "missing"
            },
            email: if local_email.is_some() {
                "local"
            } else {
                "missing"
            },
        };
        let source = if local_name.is_some() || local_email.is_some() {
            "partial"
        } else {
            "missing"
        };
        return Ok(RepoIdentityResult {
            local,
            local_name,
            local_email,
            effective: None,
            field_sources,
            source,
        });
    }

    let field_sources = IdentityFieldSources {
        name: if local_name.is_some() {
            "local"
        } else {
            "global"
        },
        email: if local_email.is_some() {
            "local"
        } else {
            "global"
        },
    };
    let source = match (&local_name, &local_email) {
        (Some(_), Some(_)) => "local",
        (Some(_), None) | (None, Some(_)) => "partial",
        (None, None) => "global",
    };
    Ok(RepoIdentityResult {
        local,
        local_name,
        local_email,
        effective: Some(GitIdentity { name, email }),
        field_sources,
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
        .map_err(|e| {
            AppError::General(format!(
                "identity write failed for root {}: {e}",
                root_path.display()
            ))
        })?;
    for sp in target_spaces {
        let p = Path::new(sp);
        set_local_identity(cli, p, name, email)
            .await
            .map_err(|e| AppError::General(format!("identity write failed for {sp}: {e}")))?;
    }
    Ok(())
}
