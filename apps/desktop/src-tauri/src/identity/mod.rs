pub mod commands;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::AppError;
use crate::git::cli::GitCli;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalIdentityResult {
    pub global: Option<GitIdentity>,
    pub source: &'static str,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalIdentityMutationResult {
    pub status: &'static str,
    pub canonical: GlobalIdentityResult,
}

#[derive(Default)]
pub struct IdentityState {
    mutation_lock: tokio::sync::Mutex<()>,
}

impl IdentityState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.mutation_lock.lock().await
    }
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

pub(crate) fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::IdentityInvalid("name"));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn validate_email(email: &str) -> Result<String, AppError> {
    let trimmed = email.trim();
    if !email_regex().is_match(trimmed) {
        return Err(AppError::IdentityInvalid("email"));
    }
    Ok(trimmed.to_string())
}

async fn get_global_identity_fields(
    cli: &GitCli,
) -> Result<(Option<String>, Option<String>), AppError> {
    let name_out = cli
        .exec_no_dir(&["config", "--global", "--get", "user.name"])
        .await?;
    let email_out = cli
        .exec_no_dir(&["config", "--global", "--get", "user.email"])
        .await?;
    let name = (name_out.exit_code == 0)
        .then(|| name_out.stdout.trim().to_string())
        .filter(|value| !value.is_empty());
    let email = (email_out.exit_code == 0)
        .then(|| email_out.stdout.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok((name, email))
}

fn global_identity_fingerprint(name: Option<&str>, email: Option<&str>) -> String {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    email.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn global_identity_result(name: Option<String>, email: Option<String>) -> GlobalIdentityResult {
    let fingerprint = global_identity_fingerprint(name.as_deref(), email.as_deref());
    let global = match (name, email) {
        (Some(name), Some(email)) => Some(GitIdentity { name, email }),
        _ => None,
    };
    let source = if global.is_some() {
        "global"
    } else {
        "missing"
    };
    GlobalIdentityResult {
        global,
        source,
        fingerprint,
    }
}

pub async fn get_global_identity_result(cli: &GitCli) -> Result<GlobalIdentityResult, AppError> {
    let (name, email) = get_global_identity_fields(cli).await?;
    Ok(global_identity_result(name, email))
}

pub async fn set_global_identity(cli: &GitCli, name: &str, email: &str) -> Result<(), AppError> {
    let name = validate_name(name)?;
    let email = validate_email(email)?;
    let (previous_name, previous_email) = get_global_identity_fields(cli).await?;

    write_global_identity_field(cli, "user.name", Some(&name)).await?;
    if let Err(error) = write_global_identity_field(cli, "user.email", Some(&email)).await {
        if let Err(rollback_error) =
            restore_global_identity_fields(cli, previous_name.as_deref(), previous_email.as_deref())
                .await
        {
            return Err(AppError::General(format!(
                "global identity update failed: {error}; rollback failed: {rollback_error}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

async fn restore_global_identity_fields(
    cli: &GitCli,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<(), AppError> {
    write_global_identity_field(cli, "user.name", name).await?;
    write_global_identity_field(cli, "user.email", email).await
}

async fn write_global_identity_field(
    cli: &GitCli,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    let output = match value {
        Some(value) => cli.exec_no_dir(&["config", "--global", key, value]).await?,
        None => {
            cli.exec_no_dir(&["config", "--global", "--unset", key])
                .await?
        }
    };
    if output.exit_code == 0 || (value.is_none() && output.exit_code == 5) {
        return Ok(());
    }
    Err(AppError::GitCommandFailed(format!(
        "git config --global {key} failed: {}",
        output.stderr.trim()
    )))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GlobalIdentityMutationPlan {
    Conflict,
    Unchanged,
    Update,
}

pub(crate) fn plan_global_identity_mutation(
    current: &GlobalIdentityResult,
    expected_fingerprint: &str,
    target: &GitIdentity,
) -> GlobalIdentityMutationPlan {
    if current.fingerprint != expected_fingerprint {
        return GlobalIdentityMutationPlan::Conflict;
    }
    if current.global.as_ref() == Some(target) {
        return GlobalIdentityMutationPlan::Unchanged;
    }
    GlobalIdentityMutationPlan::Update
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalIdentityFields {
    name: Option<String>,
    email: Option<String>,
}

pub(crate) async fn replace_local_identity_pair(
    cli: &GitCli,
    repo_path: &Path,
    name: &str,
    email: &str,
) -> Result<LocalIdentityFields, AppError> {
    let name = validate_name(name)?;
    let email = validate_email(email)?;
    let (previous_name, previous_email) = get_local_identity_fields(cli, repo_path).await?;
    let previous = LocalIdentityFields {
        name: previous_name,
        email: previous_email,
    };

    write_local_identity_field(cli, repo_path, "user.name", Some(&name)).await?;
    if let Err(error) = write_local_identity_field(cli, repo_path, "user.email", Some(&email)).await
    {
        if let Err(rollback_error) = restore_local_identity_fields(cli, repo_path, &previous).await
        {
            return Err(AppError::General(format!(
                "local identity update failed: {error}; rollback failed: {rollback_error}"
            )));
        }
        return Err(error);
    }
    Ok(previous)
}

pub(crate) async fn restore_local_identity_fields(
    cli: &GitCli,
    repo_path: &Path,
    fields: &LocalIdentityFields,
) -> Result<(), AppError> {
    write_local_identity_field(cli, repo_path, "user.name", fields.name.as_deref()).await?;
    write_local_identity_field(cli, repo_path, "user.email", fields.email.as_deref()).await
}

async fn write_local_identity_field(
    cli: &GitCli,
    repo_path: &Path,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    let output = match value {
        Some(value) => {
            cli.exec(repo_path, &["config", "--local", key, value])
                .await?
        }
        None => {
            cli.exec(repo_path, &["config", "--local", "--unset", key])
                .await?
        }
    };
    if output.exit_code == 0 || (value.is_none() && output.exit_code == 5) {
        return Ok(());
    }
    Err(AppError::GitCommandFailed(format!(
        "git config --local {key} failed: {}",
        output.stderr.trim()
    )))
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

#[cfg(test)]
mod tests {
    use super::{
        GitIdentity, GlobalIdentityMutationPlan, global_identity_result,
        plan_global_identity_mutation,
    };

    #[test]
    fn global_identity_fingerprint_covers_partial_and_complete_config() {
        let missing = global_identity_result(None, None);
        let partial = global_identity_result(Some("Alice".to_string()), None);
        let complete = global_identity_result(
            Some("Alice".to_string()),
            Some("alice@example.test".to_string()),
        );

        assert_ne!(missing.fingerprint, partial.fingerprint);
        assert_ne!(partial.fingerprint, complete.fingerprint);
        assert_eq!(partial.source, "missing");
        assert_eq!(complete.source, "global");
    }

    #[test]
    fn global_identity_plan_rejects_stale_and_skips_same_value() {
        let current = global_identity_result(
            Some("Alice".to_string()),
            Some("alice@example.test".to_string()),
        );
        let same = current.global.clone().unwrap();
        let changed = GitIdentity {
            name: "Bob".to_string(),
            email: "bob@example.test".to_string(),
        };

        assert_eq!(
            plan_global_identity_mutation(&current, "stale", &changed),
            GlobalIdentityMutationPlan::Conflict
        );
        assert_eq!(
            plan_global_identity_mutation(&current, &current.fingerprint, &same),
            GlobalIdentityMutationPlan::Unchanged
        );
        assert_eq!(
            plan_global_identity_mutation(&current, &current.fingerprint, &changed),
            GlobalIdentityMutationPlan::Update
        );
    }
}
