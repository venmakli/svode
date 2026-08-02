use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ActorCatalog;
use super::mailmap::{MailmapDocument, MailmapRule, mailmap_size_is_safe, normalize_email};
use super::resolver::{ActorCatalogState, ActorSnapshot, load_snapshot, resolve_repository};
use crate::AppError;
use crate::git::access::{RepositoryAccessState, RepositoryAccessStatus, access_store_path};
use crate::git::cli::GitCli;
use crate::identity::{
    get_effective_identity, replace_local_identity_pair, restore_local_identity_fields,
    validate_email, validate_name,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ActorMutationAction {
    Add {
        display_name: String,
        canonical_email: String,
    },
    Merge {
        source_canonical_email: String,
        target_canonical_email: String,
    },
    Edit {
        source_canonical_email: String,
        display_name: String,
        canonical_email: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorMutationBlockReason {
    AccessChecking,
    AccessReadOnly,
    AccessUnknown,
    InvalidMailmap,
    UnsafeMailmap,
    InvalidName,
    InvalidEmail,
    ActorNotFound,
    SameMergeTarget,
    NoMergeTarget,
    StalePreview,
    CurrentIdentityChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorMutationReview {
    pub action: ActorMutationAction,
    pub repository_id: String,
    pub preview_fingerprint: String,
    pub result_display_name: String,
    pub result_canonical_email: String,
    pub transferred_alias_emails: Vec<String>,
    pub affects_current_identity: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_identity_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ActorMutationPreviewResult {
    Ready {
        review: ActorMutationReview,
    },
    Duplicate {
        canonical_email: String,
    },
    Blocked {
        reason: ActorMutationBlockReason,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ActorMutationApplyResult {
    Applied {
        canonical_email: String,
        catalog: ActorCatalog,
    },
    Duplicate {
        canonical_email: String,
    },
    Blocked {
        reason: ActorMutationBlockReason,
        message: String,
    },
}

#[derive(Debug)]
struct MailmapSource {
    path: PathBuf,
    existed: bool,
    raw: String,
    fingerprint: String,
    permissions: Option<fs::Permissions>,
    document: MailmapDocument,
}

#[derive(Debug)]
struct PlannedMutation {
    action: ActorMutationAction,
    display_name: String,
    canonical_email: String,
    source_canonical_email: Option<String>,
    aliases: Vec<(Option<String>, String)>,
    affects_current_identity: bool,
}

#[derive(Debug)]
enum MutationWriteError {
    Blocked(ActorMutationBlockReason, String),
    Infrastructure(AppError),
}

impl From<std::io::Error> for MutationWriteError {
    fn from(error: std::io::Error) -> Self {
        Self::Infrastructure(AppError::Io(error))
    }
}

pub async fn preview(
    cli: &GitCli,
    space_path: &Path,
    action: ActorMutationAction,
    app: &tauri::AppHandle,
    access_state: &RepositoryAccessState,
    actor_catalog: &ActorCatalogState,
) -> Result<ActorMutationPreviewResult, AppError> {
    if let Some(blocked) = access_block(
        access_state
            .snapshot(cli, space_path, &access_store_path(app)?)
            .await?
            .status,
    ) {
        return Ok(blocked_preview(blocked));
    }

    let repository = resolve_repository(cli, space_path).await?;
    let repository_lock = actor_catalog.repository_lock(&repository)?;
    let _guard = repository_lock.lock().await;
    let source = match read_mailmap_source(&repository)? {
        Ok(source) => source,
        Err((reason, message)) => return Ok(blocked_preview_with_message(reason, message)),
    };
    let snapshot = load_snapshot(cli, &repository, 0).await?;
    let plan = match plan_mutation(&snapshot, action) {
        Ok(plan) => plan,
        Err(result) => return Ok(result),
    };
    let current_identity_fingerprint = if plan.affects_current_identity {
        Some(current_identity_fingerprint(cli, &repository).await?)
    } else {
        None
    };
    Ok(ActorMutationPreviewResult::Ready {
        review: review_for(&snapshot, &source, &plan, current_identity_fingerprint),
    })
}

pub async fn apply(
    cli: &GitCli,
    space_path: &Path,
    review: ActorMutationReview,
    app: &tauri::AppHandle,
    access_state: &RepositoryAccessState,
    actor_catalog: &ActorCatalogState,
) -> Result<ActorMutationApplyResult, AppError> {
    let repository = resolve_repository(cli, space_path).await?;
    let repository_lock = actor_catalog.repository_lock(&repository)?;
    let _guard = repository_lock.lock().await;
    let source = match read_mailmap_source(&repository)? {
        Ok(source) => source,
        Err((reason, message)) => return Ok(blocked_apply_with_message(reason, message)),
    };
    if source.fingerprint != review.preview_fingerprint {
        return Ok(blocked_apply(ActorMutationBlockReason::StalePreview));
    }

    let snapshot = load_snapshot(cli, &repository, 0).await?;
    let plan = match plan_mutation(&snapshot, review.action.clone()) {
        Ok(plan) => plan,
        Err(result) => return Ok(preview_to_apply(result)),
    };
    let current_identity_fingerprint = if plan.affects_current_identity {
        Some(current_identity_fingerprint(cli, &repository).await?)
    } else {
        None
    };
    let current_review = review_for(&snapshot, &source, &plan, current_identity_fingerprint);
    if current_review != review {
        let reason = if current_review.affects_current_identity != review.affects_current_identity
            || current_review.current_identity_fingerprint != review.current_identity_fingerprint
        {
            ActorMutationBlockReason::CurrentIdentityChanged
        } else {
            ActorMutationBlockReason::StalePreview
        };
        return Ok(blocked_apply(reason));
    }

    let patched = patch_mailmap(&source.raw, &source.document, &plan);
    validate_patched_document(&patched, &plan).map_err(AppError::General)?;

    access_state
        .require_mutation(cli, &repository, &access_store_path(app)?)
        .await?;

    let previous_identity = if plan.affects_current_identity {
        Some(
            replace_local_identity_pair(
                cli,
                &repository,
                &plan.display_name,
                &plan.canonical_email,
            )
            .await?,
        )
    } else {
        None
    };

    if let Err(error) = atomic_replace_mailmap(&source, patched.as_bytes()) {
        if let Some(previous_identity) = previous_identity.as_ref() {
            if let Err(rollback_error) =
                restore_local_identity_fields(cli, &repository, previous_identity).await
            {
                return Err(AppError::General(format!(
                    "mailmap write failed: {error:?}; local identity rollback failed: {rollback_error}"
                )));
            }
        }
        return match error {
            MutationWriteError::Blocked(reason, message) => {
                Ok(blocked_apply_with_message(reason, message))
            }
            MutationWriteError::Infrastructure(error) => Err(error),
        };
    }

    match actor_catalog.load_and_publish(cli, &repository).await {
        Ok(snapshot) => Ok(ActorMutationApplyResult::Applied {
            canonical_email: plan.canonical_email,
            catalog: snapshot.catalog(),
        }),
        Err(error) => {
            let mut rollback_errors = Vec::new();
            if let Some(previous_identity) = previous_identity.as_ref() {
                if let Err(rollback_error) =
                    restore_local_identity_fields(cli, &repository, previous_identity).await
                {
                    rollback_errors.push(format!("local identity: {rollback_error}"));
                }
            }
            if let Err(rollback_error) = restore_mailmap_source(&source) {
                rollback_errors.push(format!("mailmap: {rollback_error}"));
            }
            if rollback_errors.is_empty() {
                Err(error)
            } else {
                Err(AppError::General(format!(
                    "actor catalog refresh failed: {error}; rollback failed: {}",
                    rollback_errors.join("; ")
                )))
            }
        }
    }
}

fn plan_mutation(
    snapshot: &ActorSnapshot,
    action: ActorMutationAction,
) -> Result<PlannedMutation, ActorMutationPreviewResult> {
    match action {
        ActorMutationAction::Add {
            display_name,
            canonical_email,
        } => {
            let (display_name, canonical_email) = validate_identity(display_name, canonical_email)?;
            if let Some(existing) = snapshot.mutation_actor(&canonical_email) {
                return Err(ActorMutationPreviewResult::Duplicate {
                    canonical_email: existing.canonical_email,
                });
            }
            Ok(PlannedMutation {
                action: ActorMutationAction::Add {
                    display_name: display_name.clone(),
                    canonical_email: canonical_email.clone(),
                },
                display_name,
                canonical_email,
                source_canonical_email: None,
                aliases: Vec::new(),
                affects_current_identity: false,
            })
        }
        ActorMutationAction::Merge {
            source_canonical_email,
            target_canonical_email,
        } => {
            let source_email = normalize_email(&source_canonical_email);
            let target_email = normalize_email(&target_canonical_email);
            if source_email == target_email {
                return Err(blocked_preview(ActorMutationBlockReason::SameMergeTarget));
            }
            let source = snapshot
                .mutation_actor(&source_email)
                .filter(|actor| actor.canonical_email == source_email)
                .ok_or_else(|| blocked_preview(ActorMutationBlockReason::ActorNotFound))?;
            let target = snapshot
                .mutation_actor(&target_email)
                .filter(|actor| actor.canonical_email == target_email)
                .ok_or_else(|| blocked_preview(ActorMutationBlockReason::NoMergeTarget))?;
            let mut aliases = source.aliases;
            aliases.push((None, source.canonical_email.clone()));
            deduplicate_aliases(&mut aliases);
            Ok(PlannedMutation {
                action: ActorMutationAction::Merge {
                    source_canonical_email: source.canonical_email.clone(),
                    target_canonical_email: target.canonical_email.clone(),
                },
                display_name: target.display_name,
                canonical_email: target.canonical_email,
                source_canonical_email: Some(source.canonical_email),
                aliases,
                affects_current_identity: false,
            })
        }
        ActorMutationAction::Edit {
            source_canonical_email,
            display_name,
            canonical_email,
        } => {
            let source_email = normalize_email(&source_canonical_email);
            let source = snapshot
                .mutation_actor(&source_email)
                .filter(|actor| actor.canonical_email == source_email)
                .ok_or_else(|| blocked_preview(ActorMutationBlockReason::ActorNotFound))?;
            let (display_name, canonical_email) = validate_identity(display_name, canonical_email)?;
            if canonical_email != source.canonical_email {
                if let Some(existing) = snapshot.mutation_actor(&canonical_email) {
                    if existing.canonical_email != source.canonical_email {
                        return Err(ActorMutationPreviewResult::Duplicate {
                            canonical_email: existing.canonical_email,
                        });
                    }
                }
            }
            let mut aliases = source.aliases;
            aliases.push((None, source.canonical_email.clone()));
            deduplicate_aliases(&mut aliases);
            Ok(PlannedMutation {
                action: ActorMutationAction::Edit {
                    source_canonical_email: source.canonical_email.clone(),
                    display_name: display_name.clone(),
                    canonical_email: canonical_email.clone(),
                },
                display_name,
                canonical_email,
                source_canonical_email: Some(source.canonical_email),
                aliases,
                affects_current_identity: source.is_current,
            })
        }
    }
}

fn validate_identity(
    display_name: String,
    canonical_email: String,
) -> Result<(String, String), ActorMutationPreviewResult> {
    if display_name.contains(['\r', '\n', '<', '>', '#']) {
        return Err(blocked_preview(ActorMutationBlockReason::InvalidName));
    }
    let display_name = validate_name(&display_name)
        .map_err(|_| blocked_preview(ActorMutationBlockReason::InvalidName))?;
    if canonical_email.contains(['\r', '\n', '<', '>', '#']) {
        return Err(blocked_preview(ActorMutationBlockReason::InvalidEmail));
    }
    let canonical_email = validate_email(&canonical_email)
        .map_err(|_| blocked_preview(ActorMutationBlockReason::InvalidEmail))?;
    Ok((display_name, normalize_email(&canonical_email)))
}

fn review_for(
    snapshot: &ActorSnapshot,
    source: &MailmapSource,
    plan: &PlannedMutation,
    current_identity_fingerprint: Option<String>,
) -> ActorMutationReview {
    let transferred_alias_emails = plan
        .aliases
        .iter()
        .map(|(_, email)| email.clone())
        .filter(|email| email != &plan.canonical_email)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    ActorMutationReview {
        action: plan.action.clone(),
        repository_id: snapshot.catalog().repository_id,
        preview_fingerprint: source.fingerprint.clone(),
        result_display_name: plan.display_name.clone(),
        result_canonical_email: plan.canonical_email.clone(),
        transferred_alias_emails,
        affects_current_identity: plan.affects_current_identity,
        current_identity_fingerprint,
    }
}

async fn current_identity_fingerprint(cli: &GitCli, repository: &Path) -> Result<String, AppError> {
    let identity = get_effective_identity(cli, repository).await?;
    let fields = [
        identity.local_name.as_deref().unwrap_or_default(),
        identity.local_email.as_deref().unwrap_or_default(),
        identity
            .effective
            .as_ref()
            .map(|value| value.name.as_str())
            .unwrap_or_default(),
        identity
            .effective
            .as_ref()
            .map(|value| value.email.as_str())
            .unwrap_or_default(),
    ];
    let mut hash = 0xcbf29ce484222325_u64;
    for field in fields {
        for byte in field.as_bytes().iter().chain(std::iter::once(&0xff)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("identity-{hash:016x}"))
}

fn read_mailmap_source(
    repository: &Path,
) -> Result<Result<MailmapSource, (ActorMutationBlockReason, String)>, AppError> {
    let path = repository.join(".mailmap");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            return Ok(Err((
                ActorMutationBlockReason::UnsafeMailmap,
                format!("cannot inspect {}: {error}", path.display()),
            )));
        }
    };
    if let Some(metadata) = metadata.as_ref() {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Ok(Err((
                ActorMutationBlockReason::UnsafeMailmap,
                format!("{} is not a regular file", path.display()),
            )));
        }
        if !mailmap_size_is_safe(metadata.len()) {
            return Ok(Err((
                ActorMutationBlockReason::UnsafeMailmap,
                format!("{} exceeds the supported size limit", path.display()),
            )));
        }
    }
    let bytes = match metadata.as_ref() {
        Some(_) => match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Ok(Err((
                    ActorMutationBlockReason::UnsafeMailmap,
                    format!("cannot read {}: {error}", path.display()),
                )));
            }
        },
        None => Vec::new(),
    };
    let raw = match String::from_utf8(bytes.clone()) {
        Ok(raw) => raw,
        Err(_) => {
            return Ok(Err((
                ActorMutationBlockReason::UnsafeMailmap,
                format!("{} is not UTF-8", path.display()),
            )));
        }
    };
    let document = MailmapDocument::parse(&raw);
    if document
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.blocking)
    {
        return Ok(Err((
            ActorMutationBlockReason::InvalidMailmap,
            "the repository .mailmap contains invalid entries".into(),
        )));
    }
    Ok(Ok(MailmapSource {
        path,
        existed: metadata.is_some(),
        fingerprint: mailmap_fingerprint(metadata.is_some(), &bytes),
        permissions: metadata.map(|metadata| metadata.permissions()),
        raw,
        document,
    }))
}

fn mailmap_fingerprint(existed: bool, bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    hash ^= u64::from(existed);
    hash = hash.wrapping_mul(0x100000001b3);
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("mailmap-{hash:016x}-{}", bytes.len())
}

fn patch_mailmap(raw: &str, document: &MailmapDocument, plan: &PlannedMutation) -> String {
    let line_ending = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let affected: HashMap<usize, &MailmapRule> = plan
        .source_canonical_email
        .as_ref()
        .map(|source_email| {
            document
                .rules
                .iter()
                .filter(|rule| rule.canonical.email == *source_email)
                .map(|rule| (rule.line, rule))
                .collect()
        })
        .unwrap_or_default();
    let mut patched = String::with_capacity(raw.len() + 256);
    for (index, line) in raw.split_inclusive('\n').enumerate() {
        let line_number = index + 1;
        match affected.get(&line_number) {
            Some(rule) => patched.push_str(&rewrite_rule_line(line, rule, plan)),
            None => patched.push_str(line),
        }
    }
    let mut mappings = plan.aliases.clone();
    if plan.source_canonical_email.is_none() {
        if !patched.is_empty() && !patched.ends_with('\n') {
            patched.push_str(line_ending);
        }
        patched.push_str(&format!(
            "{} <{}>{line_ending}",
            plan.display_name, plan.canonical_email
        ));
        return patched;
    }
    deduplicate_aliases(&mut mappings);
    let patched_document = MailmapDocument::parse(&patched);
    let mut existing_aliases: BTreeSet<_> = patched_document
        .rules
        .iter()
        .filter(|rule| rule.canonical.email == plan.canonical_email)
        .map(|rule| {
            (
                rule.alias_name
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .to_lowercase(),
                rule.alias_email.clone(),
            )
        })
        .collect();
    let mut existing_generic: BTreeSet<_> = existing_aliases
        .iter()
        .filter_map(|(name, email)| name.is_empty().then_some(email.clone()))
        .collect();
    for (alias_name, alias_email) in mappings {
        let normalized_name = alias_name
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if alias_email == plan.canonical_email
            || existing_generic.contains(&alias_email)
            || !existing_aliases.insert((normalized_name, alias_email.clone()))
        {
            continue;
        }
        if !patched.is_empty() && !patched.ends_with('\n') {
            patched.push_str(line_ending);
        }
        match alias_name {
            Some(alias_name) if !alias_name.trim().is_empty() => patched.push_str(&format!(
                "{} <{}> {} <{}>{line_ending}",
                plan.display_name, plan.canonical_email, alias_name, alias_email
            )),
            _ => {
                existing_generic.insert(alias_email.clone());
                patched.push_str(&format!(
                    "{} <{}> <{}>{line_ending}",
                    plan.display_name, plan.canonical_email, alias_email
                ));
            }
        }
    }
    if affected.is_empty()
        && plan
            .aliases
            .iter()
            .all(|(_, email)| email == &plan.canonical_email)
    {
        if !patched.is_empty() && !patched.ends_with('\n') {
            patched.push_str(line_ending);
        }
        patched.push_str(&format!(
            "{} <{}>{line_ending}",
            plan.display_name, plan.canonical_email
        ));
    }
    patched
}

fn rewrite_rule_line(line: &str, rule: &MailmapRule, plan: &PlannedMutation) -> String {
    let content_start = line
        .char_indices()
        .find_map(|(index, ch)| (!ch.is_whitespace()).then_some(index))
        .unwrap_or(0);
    let Some(first_close_relative) = line[content_start..].find('>') else {
        return line.to_string();
    };
    let first_close = content_start + first_close_relative;
    let mut replacement = format!("{} <{}>", plan.display_name, plan.canonical_email);
    if rule.raw.matches('<').count() == 1 && rule.alias_email != plan.canonical_email {
        replacement.push_str(&format!(" <{}>", rule.alias_email));
    }
    format!(
        "{}{}{}",
        &line[..content_start],
        replacement,
        &line[first_close + 1..]
    )
}

fn validate_patched_document(raw: &str, plan: &PlannedMutation) -> Result<(), String> {
    let document = MailmapDocument::parse(raw);
    if let Some(diagnostic) = document
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.blocking)
    {
        return Err(format!(
            "generated invalid .mailmap: {}",
            diagnostic.message
        ));
    }
    for (name, email) in &plan.aliases {
        let resolved = document.resolve(name.as_deref().unwrap_or_default(), email);
        if resolved.email != plan.canonical_email {
            return Err(format!(
                "generated .mailmap does not resolve {email:?} to {:?}",
                plan.canonical_email
            ));
        }
    }
    Ok(())
}

fn atomic_replace_mailmap(source: &MailmapSource, bytes: &[u8]) -> Result<(), MutationWriteError> {
    write_atomic_mailmap(
        &source.path,
        source.permissions.clone(),
        bytes,
        Some(&source.fingerprint),
    )
}

fn write_atomic_mailmap(
    path: &Path,
    permissions: Option<fs::Permissions>,
    bytes: &[u8],
    expected_fingerprint: Option<&str>,
) -> Result<(), MutationWriteError> {
    let parent = path.parent().ok_or_else(|| {
        MutationWriteError::Infrastructure(AppError::General(
            ".mailmap has no parent directory".into(),
        ))
    })?;
    let temp_path = parent.join(format!(".mailmap.svode-{}.tmp", ulid::Ulid::new()));
    let result = (|| {
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        if let Some(permissions) = permissions {
            temp.set_permissions(permissions)?;
        }
        temp.write_all(bytes)?;
        temp.sync_all()?;
        if let Some(expected_fingerprint) = expected_fingerprint {
            let current = read_mailmap_source(parent)
                .map_err(MutationWriteError::Infrastructure)?
                .map_err(|(reason, message)| MutationWriteError::Blocked(reason, message))?;
            if current.fingerprint != expected_fingerprint {
                return Err(MutationWriteError::Blocked(
                    ActorMutationBlockReason::StalePreview,
                    blocked_message(ActorMutationBlockReason::StalePreview).into(),
                ));
            }
        }
        fs::rename(&temp_path, path)?;
        #[cfg(unix)]
        if let Err(error) = fs::File::open(parent).and_then(|directory| directory.sync_all()) {
            tracing::warn!(
                "failed to sync directory after atomic .mailmap replace in {}: {error}",
                parent.display()
            );
        }
        Ok::<_, MutationWriteError>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp_path);
        return match error {
            MutationWriteError::Blocked(..) => Err(error),
            MutationWriteError::Infrastructure(error) => {
                Err(MutationWriteError::Infrastructure(AppError::General(
                    format!("failed to atomically replace {}: {error}", path.display()),
                )))
            }
        };
    }
    Ok(())
}

fn restore_mailmap_source(source: &MailmapSource) -> Result<(), AppError> {
    if source.existed {
        write_atomic_mailmap(
            &source.path,
            source.permissions.clone(),
            source.raw.as_bytes(),
            None,
        )
        .map_err(|error| match error {
            MutationWriteError::Infrastructure(error) => error,
            MutationWriteError::Blocked(_, message) => AppError::General(message),
        })
    } else {
        match fs::remove_file(&source.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::General(format!(
                "failed to restore absent {}: {error}",
                source.path.display()
            ))),
        }
    }
}

fn deduplicate_aliases(aliases: &mut Vec<(Option<String>, String)>) {
    let mut seen = BTreeSet::new();
    aliases.retain(|(name, email)| {
        seen.insert((
            name.as_deref().unwrap_or_default().to_lowercase(),
            normalize_email(email),
        ))
    });
    for (_, email) in aliases {
        *email = normalize_email(email);
    }
}

fn access_block(status: RepositoryAccessStatus) -> Option<ActorMutationBlockReason> {
    match status {
        RepositoryAccessStatus::Local | RepositoryAccessStatus::Writable => None,
        RepositoryAccessStatus::Checking => Some(ActorMutationBlockReason::AccessChecking),
        RepositoryAccessStatus::ReadOnly => Some(ActorMutationBlockReason::AccessReadOnly),
        RepositoryAccessStatus::Unknown => Some(ActorMutationBlockReason::AccessUnknown),
    }
}

fn blocked_message(reason: ActorMutationBlockReason) -> &'static str {
    match reason {
        ActorMutationBlockReason::AccessChecking => "repository access is still being checked",
        ActorMutationBlockReason::AccessReadOnly => "repository access is read-only",
        ActorMutationBlockReason::AccessUnknown => "repository access is unknown",
        ActorMutationBlockReason::InvalidMailmap => "the repository .mailmap is invalid",
        ActorMutationBlockReason::UnsafeMailmap => "the repository .mailmap is unsafe to modify",
        ActorMutationBlockReason::InvalidName => "display name is invalid",
        ActorMutationBlockReason::InvalidEmail => "canonical email is invalid",
        ActorMutationBlockReason::ActorNotFound => "actor is not present in the repository catalog",
        ActorMutationBlockReason::SameMergeTarget => "source and target identities are the same",
        ActorMutationBlockReason::NoMergeTarget => "no visible merge target is available",
        ActorMutationBlockReason::StalePreview => "the review is stale; refresh and review again",
        ActorMutationBlockReason::CurrentIdentityChanged => {
            "the current Git identity changed; refresh and review again"
        }
    }
}

fn blocked_preview(reason: ActorMutationBlockReason) -> ActorMutationPreviewResult {
    blocked_preview_with_message(reason, blocked_message(reason).into())
}

fn blocked_preview_with_message(
    reason: ActorMutationBlockReason,
    message: String,
) -> ActorMutationPreviewResult {
    ActorMutationPreviewResult::Blocked { reason, message }
}

fn blocked_apply(reason: ActorMutationBlockReason) -> ActorMutationApplyResult {
    blocked_apply_with_message(reason, blocked_message(reason).into())
}

fn blocked_apply_with_message(
    reason: ActorMutationBlockReason,
    message: String,
) -> ActorMutationApplyResult {
    ActorMutationApplyResult::Blocked { reason, message }
}

fn preview_to_apply(result: ActorMutationPreviewResult) -> ActorMutationApplyResult {
    match result {
        ActorMutationPreviewResult::Duplicate { canonical_email } => {
            ActorMutationApplyResult::Duplicate { canonical_email }
        }
        ActorMutationPreviewResult::Blocked { reason, message } => {
            ActorMutationApplyResult::Blocked { reason, message }
        }
        ActorMutationPreviewResult::Ready { .. } => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;
    use crate::actors::resolver::ActorContribution;
    use crate::identity::get_local_identity_fields;

    fn plan(
        display_name: &str,
        canonical_email: &str,
        source_email: Option<&str>,
        aliases: &[(&str, &str)],
    ) -> PlannedMutation {
        PlannedMutation {
            action: ActorMutationAction::Edit {
                source_canonical_email: source_email.unwrap_or(canonical_email).into(),
                display_name: display_name.into(),
                canonical_email: canonical_email.into(),
            },
            display_name: display_name.into(),
            canonical_email: canonical_email.into(),
            source_canonical_email: source_email.map(str::to_string),
            aliases: aliases
                .iter()
                .map(|(name, email)| {
                    (
                        (!name.is_empty()).then(|| (*name).to_string()),
                        (*email).to_string(),
                    )
                })
                .collect(),
            affects_current_identity: false,
        }
    }

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .env("LC_ALL", "C")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(name: &str, email: &str) -> tempfile::TempDir {
        let repo = tempfile::tempdir().expect("temp repo");
        git(repo.path(), &["init", "--quiet"]);
        git(repo.path(), &["config", "user.name", name]);
        git(repo.path(), &["config", "user.email", email]);
        repo
    }

    fn commit_as(path: &Path, file: &str, name: &str, email: &str) {
        fs::write(path.join(file), file).expect("write commit file");
        git(path, &["add", file]);
        git(
            path,
            &[
                "-c",
                &format!("user.name={name}"),
                "-c",
                &format!("user.email={email}"),
                "commit",
                "--quiet",
                "-m",
                file,
            ],
        );
    }

    #[test]
    fn add_preserves_existing_bytes_and_uses_existing_crlf() {
        let raw = "# keep\r\nOther <other@test>\r\n";
        let document = MailmapDocument::parse(raw);
        let mut plan = plan("New User", "new@example.test", None, &[]);
        plan.action = ActorMutationAction::Add {
            display_name: "New User".into(),
            canonical_email: "new@example.test".into(),
        };

        let patched = patch_mailmap(raw, &document, &plan);

        assert_eq!(
            patched,
            "# keep\r\nOther <other@test>\r\nNew User <new@example.test>\r\n"
        );
        assert_eq!(
            MailmapDocument::parse(&patched)
                .resolve("", "new@example.test")
                .name,
            "New User"
        );
    }

    #[test]
    fn merge_rewrites_source_rules_and_keeps_comments_order_and_crlf() {
        let raw = "# first\r\nOld <old@test> Commit Name <alias@test> # keep\r\nUnrelated <u@test> <ua@test>\r\n";
        let document = MailmapDocument::parse(raw);
        let plan = plan(
            "Target",
            "target@test",
            Some("old@test"),
            &[("Commit Name", "alias@test"), ("", "old@test")],
        );

        let patched = patch_mailmap(raw, &document, &plan);

        assert!(patched.starts_with(
            "# first\r\nTarget <target@test> Commit Name <alias@test> # keep\r\nUnrelated <u@test> <ua@test>\r\n"
        ));
        assert_eq!(
            MailmapDocument::parse(&patched)
                .resolve("Commit Name", "alias@test")
                .email,
            "target@test"
        );
        assert_eq!(
            MailmapDocument::parse(&patched)
                .resolve("Legacy", "old@test")
                .email,
            "target@test"
        );
    }

    #[test]
    fn edit_keeps_old_canonical_and_all_aliases_resolving_to_new_identity() {
        let raw = "Old <old@test> <alias-one@test>\nOld <old@test> Named <alias-two@test>\n";
        let document = MailmapDocument::parse(raw);
        let plan = plan(
            "New",
            "new@test",
            Some("old@test"),
            &[
                ("", "old@test"),
                ("", "alias-one@test"),
                ("Named", "alias-two@test"),
            ],
        );

        let patched = patch_mailmap(raw, &document, &plan);
        validate_patched_document(&patched, &plan).expect("valid edited document");
        let parsed = MailmapDocument::parse(&patched);
        assert_eq!(parsed.resolve("", "old@test").email, "new@test");
        assert_eq!(parsed.resolve("", "alias-one@test").email, "new@test");
        assert_eq!(parsed.resolve("Named", "alias-two@test").email, "new@test");
    }

    #[test]
    fn merge_preserves_name_specific_alias_boundaries() {
        let raw = "Old <old@test> Alice <shared@test>\nOther <other@test> Bob <shared@test>\n";
        let document = MailmapDocument::parse(raw);
        let plan = plan(
            "Target",
            "target@test",
            Some("old@test"),
            &[("Alice", "shared@test"), ("", "old@test")],
        );

        let patched = patch_mailmap(raw, &document, &plan);
        let parsed = MailmapDocument::parse(&patched);

        assert_eq!(parsed.resolve("Alice", "shared@test").email, "target@test");
        assert_eq!(parsed.resolve("Bob", "shared@test").email, "other@test");
        assert!(!patched.contains("Target <target@test> <shared@test>"));
    }

    #[test]
    fn fingerprint_changes_for_external_edit_and_existence() {
        assert_ne!(
            mailmap_fingerprint(true, b"one\n"),
            mailmap_fingerprint(true, b"two\n")
        );
        assert_ne!(
            mailmap_fingerprint(false, b""),
            mailmap_fingerprint(true, b"")
        );
    }

    #[test]
    fn access_states_map_to_typed_blocks() {
        assert_eq!(access_block(RepositoryAccessStatus::Local), None);
        assert_eq!(access_block(RepositoryAccessStatus::Writable), None);
        assert_eq!(
            access_block(RepositoryAccessStatus::Checking),
            Some(ActorMutationBlockReason::AccessChecking)
        );
        assert_eq!(
            access_block(RepositoryAccessStatus::ReadOnly),
            Some(ActorMutationBlockReason::AccessReadOnly)
        );
        assert_eq!(
            access_block(RepositoryAccessStatus::Unknown),
            Some(ActorMutationBlockReason::AccessUnknown)
        );
    }

    #[test]
    fn typed_results_use_camel_case_payload_fields() {
        let value = serde_json::to_value(ActorMutationPreviewResult::Duplicate {
            canonical_email: "existing@example.test".into(),
        })
        .expect("serialize result");
        assert_eq!(value["status"], "duplicate");
        assert_eq!(value["canonicalEmail"], "existing@example.test");
        assert!(value.get("canonical_email").is_none());
    }

    #[test]
    fn invalid_and_symlink_mailmaps_are_typed_blocks() {
        let repo = tempfile::tempdir().expect("temp repo");
        fs::write(repo.path().join(".mailmap"), "invalid\n").expect("write invalid");
        let invalid = read_mailmap_source(repo.path()).expect("read");
        assert!(matches!(
            invalid,
            Err((ActorMutationBlockReason::InvalidMailmap, _))
        ));

        #[cfg(unix)]
        {
            fs::remove_file(repo.path().join(".mailmap")).expect("remove invalid");
            std::os::unix::fs::symlink("target", repo.path().join(".mailmap"))
                .expect("create symlink");
            let symlink = read_mailmap_source(repo.path()).expect("read");
            assert!(matches!(
                symlink,
                Err((ActorMutationBlockReason::UnsafeMailmap, _))
            ));
        }
    }

    #[test]
    fn atomic_replace_preserves_regular_file_permissions() {
        let repo = tempfile::tempdir().expect("temp repo");
        fs::write(repo.path().join(".mailmap"), "Old <old@test>\n").expect("write source");
        let source = read_mailmap_source(repo.path())
            .expect("read")
            .expect("safe source");
        atomic_replace_mailmap(&source, b"New <new@test>\n").expect("atomic replace");
        assert_eq!(
            fs::read_to_string(repo.path().join(".mailmap")).expect("read result"),
            "New <new@test>\n"
        );
        assert!(
            fs::symlink_metadata(repo.path().join(".mailmap"))
                .expect("metadata")
                .is_file()
        );
    }

    #[tokio::test]
    async fn add_materializes_no_commit_row_and_duplicate_is_non_writing() {
        let repo = init_repo("Current", "current@example.test");
        let cli = GitCli::detect().expect("git CLI");
        let snapshot = load_snapshot(&cli, repo.path(), 0)
            .await
            .expect("initial snapshot");
        let action = ActorMutationAction::Add {
            display_name: "New Actor".into(),
            canonical_email: "new@example.test".into(),
        };
        let mutation = plan_mutation(&snapshot, action.clone()).expect("add plan");
        let source = read_mailmap_source(repo.path())
            .expect("read")
            .expect("safe source");
        let patched = patch_mailmap(&source.raw, &source.document, &mutation);
        atomic_replace_mailmap(&source, patched.as_bytes()).expect("write add");

        let refreshed = load_snapshot(&cli, repo.path(), 0)
            .await
            .expect("refreshed snapshot");
        let added = refreshed
            .catalog()
            .rows
            .into_iter()
            .find(|row| row.canonical_email == "new@example.test")
            .expect("new actor row");
        assert_eq!(added.contribution, ActorContribution::NoCommits);
        assert_eq!(added.commit_count, 0);

        let before_duplicate = fs::read(repo.path().join(".mailmap")).expect("mailmap bytes");
        assert!(matches!(
            plan_mutation(&refreshed, action),
            Err(ActorMutationPreviewResult::Duplicate { canonical_email })
                if canonical_email == "new@example.test"
        ));
        assert_eq!(
            fs::read(repo.path().join(".mailmap")).expect("mailmap bytes"),
            before_duplicate
        );
    }

    #[tokio::test]
    async fn successful_write_publishes_exactly_one_new_repository_generation() {
        let repo = init_repo("Current", "current@example.test");
        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();
        let initial = state
            .snapshot(&cli, repo.path())
            .await
            .expect("initial snapshot");
        assert_eq!(initial.catalog().generation, 1);
        let repository = resolve_repository(&cli, repo.path())
            .await
            .expect("repository");
        let lock = state.repository_lock(&repository).expect("repository lock");
        let _guard = lock.lock().await;
        let current = load_snapshot(&cli, &repository, 0)
            .await
            .expect("current snapshot");
        let mutation = plan_mutation(
            &current,
            ActorMutationAction::Add {
                display_name: "New Actor".into(),
                canonical_email: "new@example.test".into(),
            },
        )
        .expect("add plan");
        let source = read_mailmap_source(&repository)
            .expect("read")
            .expect("safe source");
        let patched = patch_mailmap(&source.raw, &source.document, &mutation);
        atomic_replace_mailmap(&source, patched.as_bytes()).expect("atomic replace");
        let published = state
            .load_and_publish(&cli, &repository)
            .await
            .expect("publish mutation");

        assert_eq!(published.catalog().generation, 2);
    }

    #[tokio::test]
    async fn merge_moves_every_alias_and_legacy_references_to_target() {
        let repo = init_repo("Target", "target@example.test");
        commit_as(repo.path(), "target.txt", "Target", "target@example.test");
        commit_as(repo.path(), "old.txt", "Old Commit", "alias@example.test");
        fs::write(
            repo.path().join(".mailmap"),
            "# actors\nOld <old@example.test> Old Commit <alias@example.test> # legacy\n",
        )
        .expect("write mailmap");
        let cli = GitCli::detect().expect("git CLI");
        let snapshot = load_snapshot(&cli, repo.path(), 0)
            .await
            .expect("initial snapshot");
        let mutation = plan_mutation(
            &snapshot,
            ActorMutationAction::Merge {
                source_canonical_email: "old@example.test".into(),
                target_canonical_email: "target@example.test".into(),
            },
        )
        .expect("merge plan");
        let source = read_mailmap_source(repo.path())
            .expect("read")
            .expect("safe source");
        let patched = patch_mailmap(&source.raw, &source.document, &mutation);
        validate_patched_document(&patched, &mutation).expect("valid merge");
        atomic_replace_mailmap(&source, patched.as_bytes()).expect("write merge");

        let refreshed = load_snapshot(&cli, repo.path(), 0)
            .await
            .expect("refreshed snapshot");
        assert!(
            refreshed
                .catalog()
                .rows
                .iter()
                .all(|row| row.canonical_email != "old@example.test")
        );
        let target = refreshed
            .catalog()
            .rows
            .into_iter()
            .find(|row| row.canonical_email == "target@example.test")
            .expect("target row");
        assert_eq!(target.commit_count, 2);
        assert_eq!(
            refreshed.canonical_email("Persisted Actor", "old@example.test"),
            "target@example.test"
        );
        assert_eq!(
            refreshed.canonical_email("Old Commit", "alias@example.test"),
            "target@example.test"
        );
    }

    #[tokio::test]
    async fn edit_distinguishes_non_current_and_updates_current_local_pair() {
        let repo = init_repo("Current", "current@example.test");
        commit_as(repo.path(), "other.txt", "Other", "other@example.test");
        let cli = GitCli::detect().expect("git CLI");
        let snapshot = load_snapshot(&cli, repo.path(), 0)
            .await
            .expect("initial snapshot");
        let non_current = plan_mutation(
            &snapshot,
            ActorMutationAction::Edit {
                source_canonical_email: "other@example.test".into(),
                display_name: "Other Renamed".into(),
                canonical_email: "other-new@example.test".into(),
            },
        )
        .expect("non-current edit");
        assert!(!non_current.affects_current_identity);

        let current = plan_mutation(
            &snapshot,
            ActorMutationAction::Edit {
                source_canonical_email: "current@example.test".into(),
                display_name: "Current Renamed".into(),
                canonical_email: "current-new@example.test".into(),
            },
        )
        .expect("current edit");
        assert!(current.affects_current_identity);
        let source = read_mailmap_source(repo.path())
            .expect("read")
            .expect("safe source");
        let patched = patch_mailmap(&source.raw, &source.document, &current);
        let previous_identity = replace_local_identity_pair(
            &cli,
            repo.path(),
            &current.display_name,
            &current.canonical_email,
        )
        .await
        .expect("write local pair");
        atomic_replace_mailmap(&source, patched.as_bytes()).expect("write edit");

        assert_eq!(
            get_local_identity_fields(&cli, repo.path())
                .await
                .expect("local identity"),
            (
                Some("Current Renamed".into()),
                Some("current-new@example.test".into())
            )
        );
        let refreshed = load_snapshot(&cli, repo.path(), 0)
            .await
            .expect("refreshed snapshot");
        assert_eq!(refreshed.current_email(), Some("current-new@example.test"));
        assert_eq!(
            refreshed.canonical_email("Current", "current@example.test"),
            "current-new@example.test"
        );
        restore_local_identity_fields(&cli, repo.path(), &previous_identity)
            .await
            .expect("compensate local pair");
        assert_eq!(
            get_local_identity_fields(&cli, repo.path())
                .await
                .expect("restored local identity"),
            (Some("Current".into()), Some("current@example.test".into()))
        );
    }

    #[tokio::test]
    async fn current_identity_fingerprint_detects_external_config_edit() {
        let repo = init_repo("Current", "current@example.test");
        let cli = GitCli::detect().expect("git CLI");
        let preview = current_identity_fingerprint(&cli, repo.path())
            .await
            .expect("preview fingerprint");
        git(repo.path(), &["config", "user.name", "Externally Changed"]);
        let apply = current_identity_fingerprint(&cli, repo.path())
            .await
            .expect("apply fingerprint");

        assert_ne!(preview, apply);
    }

    #[test]
    fn external_edit_makes_preview_fingerprint_stale_before_write() {
        let repo = tempfile::tempdir().expect("temp repo");
        fs::write(repo.path().join(".mailmap"), "One <one@example.test>\n").expect("write initial");
        let preview = read_mailmap_source(repo.path())
            .expect("read")
            .expect("safe preview");
        fs::write(
            repo.path().join(".mailmap"),
            "One <one@example.test>\n# external\n",
        )
        .expect("external edit");
        let apply = read_mailmap_source(repo.path())
            .expect("read")
            .expect("safe apply");

        assert_ne!(preview.fingerprint, apply.fingerprint);
        assert!(matches!(
            atomic_replace_mailmap(&preview, b"Two <two@example.test>\n"),
            Err(MutationWriteError::Blocked(
                ActorMutationBlockReason::StalePreview,
                _
            ))
        ));
        assert_eq!(apply.raw, "One <one@example.test>\n# external\n");
        assert_eq!(
            fs::read_to_string(repo.path().join(".mailmap")).expect("read after stale write"),
            apply.raw
        );
    }
}
