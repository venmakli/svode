//! Routine definitions through the shared core service and explicit launch
//! through the host execution owner.
//!
//! Create and update confirm a complete definition with canonical naming.
//! The core service authorizes the owner repository before the first write
//! and runs without autocommit; `run_routine` authorizes the owner Space and
//! hands the launch to the host. A Routine-launched caller keeps the Routine
//! origin policy and cannot start another Routine.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::git::state::GitRuntime;
use svode_core::routines::model::{
    ResolvedRoutineOwner, RoutineCatalogSnapshot, RoutineDefinition, RoutineDispatchBlockedCode,
    RoutineDispatchResult, RoutineOwnerInputKind, RoutineRow,
};
use svode_core::routines::service::{
    self, ManagedRoutineMutationResult, RoutineMutationContext, RoutineMutationHost,
    RoutineMutationIntent, RoutineMutationOrigin, RoutineMutationPolicyContext,
    RoutineNamingIntent, RoutineRepositoryTarget, RoutineServiceError, RoutineValidationIntent,
};

use crate::args::{clamp_limit, offset};
use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
use crate::mutation::{authorize_paths, within_authorized_launch};
use crate::path::validate_public_rel_path;
use crate::result::{ContentBlock, ToolCallResult};
use crate::target::resolve_space;

const AUTHORITY_UNAVAILABLE_CODE: &str = "routine_authority_unavailable";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListRoutinesArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GetRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    routine_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    #[serde(deserialize_with = "deserialize_routine_definition")]
    definition: RoutineDefinition,
    #[serde(default)]
    confirm_automatic_execution: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    routine_id: String,
    expected_fingerprint: String,
    #[serde(deserialize_with = "deserialize_routine_definition")]
    definition: RoutineDefinition,
    #[serde(default)]
    confirm_automatic_execution: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    routine_id: String,
    expected_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    routine_id: String,
    expected_fingerprint: String,
}

#[derive(Debug)]
struct AuthorityProjection {
    enabled: Option<bool>,
    diagnostics: Vec<Value>,
}

fn deserialize_routine_definition<'de, D>(deserializer: D) -> Result<RoutineDefinition, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    validate_definition_shape(&value).map_err(serde::de::Error::custom)?;
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

fn validate_definition_shape(value: &Value) -> Result<(), String> {
    let Some(definition) = value.as_object() else {
        return Ok(());
    };
    reject_unknown_keys(
        definition,
        &[
            "name",
            "description",
            "enabled",
            "trigger",
            "action",
            "body",
        ],
        "definition",
    )?;
    for required in ["name", "trigger", "action", "body"] {
        if !definition.contains_key(required) {
            return Err(format!("missing field definition.{required}"));
        }
    }
    if let Some(trigger) = definition.get("trigger").and_then(Value::as_object) {
        match trigger.get("type").and_then(Value::as_str) {
            Some("manual") => reject_unknown_keys(trigger, &["type"], "definition.trigger")?,
            Some("schedule") => reject_unknown_keys(
                trigger,
                &["type", "cron", "timeBasis", "missedRuns"],
                "definition.trigger",
            )?,
            Some("event") => {
                reject_unknown_keys(trigger, &["type", "event", "match"], "definition.trigger")?;
                if let Some(matcher) = trigger.get("match").and_then(Value::as_object) {
                    reject_unknown_keys(
                        matcher,
                        &["field", "from", "to"],
                        "definition.trigger.match",
                    )?;
                }
            }
            _ => {}
        }
        if trigger.get("type").and_then(Value::as_str) == Some("schedule")
            && let Some(time_basis) = trigger.get("timeBasis").and_then(Value::as_object)
        {
            match time_basis.get("mode").and_then(Value::as_str) {
                Some("local") => {
                    reject_unknown_keys(time_basis, &["mode"], "definition.trigger.timeBasis")?
                }
                Some("fixed") => reject_unknown_keys(
                    time_basis,
                    &["mode", "timezone"],
                    "definition.trigger.timeBasis",
                )?,
                _ => {}
            }
        }
    }
    if let Some(action) = definition.get("action").and_then(Value::as_object) {
        match action.get("type").and_then(Value::as_str) {
            Some("run_agent") => {
                reject_unknown_keys(action, &["type", "executor"], "definition.action")?
            }
            Some("update_properties") => {
                reject_unknown_keys(action, &["type", "target", "set"], "definition.action")?
            }
            _ => {}
        }
    }
    Ok(())
}

fn reject_unknown_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    field: &str,
) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("unknown field {field}.{key}"));
    }
    Ok(())
}

/// Host capabilities of a managed Routine mutation: the Git target of an
/// owner from the host Git runtime and repository authorization through the
/// host access state.
struct RoutineHost<'a, H> {
    host: &'a H,
    git: &'a GitRuntime,
}

impl<H: ToolHost> RoutineRepositoryTarget for RoutineHost<'_, H> {
    type Error = ToolError;

    async fn mutation_repository(
        &self,
        owner: &ResolvedRoutineOwner,
    ) -> Result<PathBuf, ToolError> {
        let (_, repository) = svode_core::git::ops::resolve_target_repo(
            self.git.cli()?,
            &owner.project_path,
            &owner.space_path,
        )
        .await?;
        Ok(repository)
    }
}

impl<H: ToolHost> RoutineMutationHost for RoutineHost<'_, H> {
    async fn authorize_mutation(&self, repository: &Path) -> Result<(), ToolError> {
        self.host.require_mutation_access(repository).await
    }
}

pub(crate) async fn list_routines(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: ListRoutinesArgs,
) -> Result<ToolCallResult, ToolError> {
    let owner = resolve_routine_owner(target, &args.space_id, args.collection_path.as_deref())?;
    let (snapshot, authority) = read_owner(host, &owner).await?;
    let structured = list_payload(&snapshot, authority, args.limit, args.offset);
    let returned = structured["routines"]
        .as_array()
        .map_or(0, std::vec::Vec::len);
    Ok(ToolCallResult::ok(
        format!(
            "Found {returned} of {} routines for the explicit owner.",
            snapshot.routines.len()
        ),
        structured,
    ))
}

pub(crate) async fn get_routine(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: GetRoutineArgs,
) -> Result<ToolCallResult, ToolError> {
    let owner = resolve_routine_owner(target, &args.space_id, args.collection_path.as_deref())?;
    let (snapshot, authority) = read_owner(host, &owner).await?;
    let row = find_routine(&snapshot, &args.routine_id)?;
    Ok(ToolCallResult::ok(
        format!("Read routine {} for the explicit owner.", args.routine_id),
        detail_payload(&snapshot, row, authority),
    ))
}

/// Catalog of one owner with its exact-owner automatic authority.
async fn read_owner(
    host: &impl ToolHost,
    owner: &ResolvedRoutineOwner,
) -> Result<(RoutineCatalogSnapshot, AuthorityProjection), ToolError> {
    let routines = host.routine_runtime()?;
    let index = host.read_runtime().index;
    let snapshot =
        service::read_catalog(routines.stores, index, &routines.live_evidence, owner).await?;
    let authority = authority_projection(
        service::read_automatic_authority(routines.stores, index, owner).await,
    );
    Ok((snapshot, authority))
}

pub(crate) async fn create_routine(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: CreateRoutineArgs,
) -> Result<ToolCallResult, ToolError> {
    let owner = resolve_routine_owner(target, &args.space_id, args.collection_path.as_deref())?;
    let routines = host.routine_runtime()?;
    let read = host.read_runtime();
    let context = RoutineMutationContext {
        repositories: read.git.repository(),
        routine_stores: routines.stores,
        index_state: read.index,
        live_evidence: &routines.live_evidence,
    };
    let result = Box::pin(service::create_managed(
        owner.clone(),
        args.definition,
        strict_materializing_intent(),
        mutation_policy(target, args.confirm_automatic_execution.unwrap_or(false)),
        &context,
        &RoutineHost {
            host,
            git: read.git,
        },
    ))
    .await?;
    mutation_result(host, &owner, result, MutationKind::Create).await
}

pub(crate) async fn update_routine(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateRoutineArgs,
) -> Result<ToolCallResult, ToolError> {
    validate_mutation_identity(&args.routine_id, &args.expected_fingerprint)?;
    let owner = resolve_routine_owner(target, &args.space_id, args.collection_path.as_deref())?;
    let routines = host.routine_runtime()?;
    let read = host.read_runtime();
    let context = RoutineMutationContext {
        repositories: read.git.repository(),
        routine_stores: routines.stores,
        index_state: read.index,
        live_evidence: &routines.live_evidence,
    };
    let result = Box::pin(service::update_managed(
        owner.clone(),
        args.routine_id,
        args.expected_fingerprint,
        args.definition,
        strict_materializing_intent(),
        mutation_policy(target, args.confirm_automatic_execution.unwrap_or(false)),
        &context,
        &RoutineHost {
            host,
            git: read.git,
        },
    ))
    .await?;
    mutation_result(host, &owner, result, MutationKind::Update).await
}

pub(crate) async fn delete_routine(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: DeleteRoutineArgs,
) -> Result<ToolCallResult, ToolError> {
    validate_mutation_identity(&args.routine_id, &args.expected_fingerprint)?;
    let owner = resolve_routine_owner(target, &args.space_id, args.collection_path.as_deref())?;
    let routines = host.routine_runtime()?;
    let read = host.read_runtime();
    let context = RoutineMutationContext {
        repositories: read.git.repository(),
        routine_stores: routines.stores,
        index_state: read.index,
        live_evidence: &routines.live_evidence,
    };
    let result = Box::pin(service::delete_managed(
        owner.clone(),
        args.routine_id,
        args.expected_fingerprint,
        &context,
        &RoutineHost {
            host,
            git: read.git,
        },
    ))
    .await?;
    mutation_result(host, &owner, result, MutationKind::Delete).await
}

pub(crate) async fn run_routine(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: RunRoutineArgs,
) -> Result<ToolCallResult, ToolError> {
    validate_mutation_identity(&args.routine_id, &args.expected_fingerprint)?;
    if target.routine_caller.is_some() {
        return Ok(dispatch_result(RoutineDispatchResult::Blocked {
            routine_id: args.routine_id,
            code: RoutineDispatchBlockedCode::RecursionGuard,
            message: "a routine-launched MCP caller cannot run a Routine".to_string(),
            current_fingerprint: None,
        }));
    }
    let runner = host
        .routine_runner()
        .ok_or_else(|| ToolError::new("UNKNOWN_TOOL", "unknown Svode MCP tool: run_routine"))?;
    let owner = resolve_routine_owner(target, &args.space_id, args.collection_path.as_deref())?;
    let paths = authorize_paths(host, vec![owner.space_path.clone()]).await?;
    let result = within_authorized_launch(
        paths,
        runner.run(owner, args.routine_id, args.expected_fingerprint),
    )
    .await?;
    Ok(dispatch_result(result))
}

fn mutation_policy(
    target: &RequestTarget,
    confirm_automatic_execution: bool,
) -> RoutineMutationPolicyContext {
    RoutineMutationPolicyContext {
        origin: if target.routine_caller.is_some() {
            RoutineMutationOrigin::RoutineAgent
        } else {
            RoutineMutationOrigin::ExternalAgent
        },
        automatic_execution_acknowledged: confirm_automatic_execution,
    }
}

fn strict_materializing_intent() -> RoutineMutationIntent {
    RoutineMutationIntent {
        validation: RoutineValidationIntent::CompleteDefinition,
        naming: RoutineNamingIntent::MaterializeCanonicalFilename,
    }
}

fn dispatch_result(result: RoutineDispatchResult) -> ToolCallResult {
    let (text, structured) = match result {
        RoutineDispatchResult::Started {
            routine_id,
            routine_run_id,
            launch_id,
            agent_session_id,
            source_session_id,
            pty_id,
        } => (
            format!("Started routine {routine_id} without waiting for completion."),
            json!({
                "status": "started",
                "routineId": routine_id,
                "routineRunId": routine_run_id,
                "launchId": launch_id,
                "agentSessionId": agent_session_id,
                "sourceSessionId": source_session_id,
                "ptyId": pty_id,
            }),
        ),
        RoutineDispatchResult::AlreadyRunning {
            routine_id,
            routine_run_id,
            launch_id,
            agent_session_id,
            source_session_id,
            pty_id,
        } => (
            format!("Routine {routine_id} is already running; no second process was started."),
            json!({
                "status": "already_running",
                "routineId": routine_id,
                "routineRunId": routine_run_id,
                "launchId": launch_id,
                "agentSessionId": agent_session_id,
                "sourceSessionId": source_session_id,
                "ptyId": pty_id,
            }),
        ),
        RoutineDispatchResult::Blocked {
            routine_id,
            code,
            message,
            current_fingerprint,
        } => (
            message.clone(),
            json!({
                "status": "blocked",
                "routineId": routine_id,
                "code": code.as_str(),
                "message": message,
                "currentFingerprint": current_fingerprint,
            }),
        ),
        RoutineDispatchResult::Failed {
            routine_id,
            routine_run_id,
            launch_id,
            agent_session_id,
            source_session_id,
            pty_id,
            message,
        } => (
            message.clone(),
            json!({
                "status": "failed",
                "routineId": routine_id,
                "routineRunId": routine_run_id,
                "launchId": launch_id,
                "agentSessionId": agent_session_id,
                "sourceSessionId": source_session_id,
                "ptyId": pty_id,
                "message": message,
            }),
        ),
        RoutineDispatchResult::Completed => {
            unreachable!("explicit Routine run cannot complete without an Agent Session")
        }
    };
    ToolCallResult::ok(text, structured)
}

#[derive(Debug, Clone, Copy)]
enum MutationKind {
    Create,
    Update,
    Delete,
}

impl MutationKind {
    fn past_tense(self) -> &'static str {
        match self {
            Self::Create => "Created",
            Self::Update => "Updated",
            Self::Delete => "Deleted",
        }
    }
}

async fn mutation_result(
    host: &impl ToolHost,
    owner: &ResolvedRoutineOwner,
    result: ManagedRoutineMutationResult,
    kind: MutationKind,
) -> Result<ToolCallResult, ToolError> {
    match result {
        ManagedRoutineMutationResult::Applied {
            routine_id,
            snapshot,
            changed_paths,
            warnings,
        } => {
            host.deliver_routine_invalidation(owner);
            let authority = authority_projection(
                service::read_automatic_authority(
                    host.routine_runtime()?.stores,
                    host.read_runtime().index,
                    owner,
                )
                .await,
            );
            let structured = match kind {
                MutationKind::Delete => json!({
                    "owner": snapshot.owner,
                    "routineId": routine_id,
                    "path": changed_paths.first(),
                    "catalogFingerprint": snapshot.catalog_fingerprint,
                    "changedPaths": changed_paths,
                    "warnings": warnings,
                    "automaticAuthorityEnabled": authority.enabled,
                    "authorityDiagnostics": authority.diagnostics,
                }),
                MutationKind::Create | MutationKind::Update => {
                    let row = find_routine(&snapshot, &routine_id)?;
                    json!({
                        "owner": snapshot.owner,
                        "routineId": routine_id,
                        "path": row.path,
                        "fingerprint": row.fingerprint,
                        "catalogFingerprint": snapshot.catalog_fingerprint,
                        "changedPaths": changed_paths,
                        "detail": detail_payload(&snapshot, row, authority),
                        "warnings": warnings,
                    })
                }
            };
            Ok(ToolCallResult::ok(
                format!(
                    "{} routine {routine_id} without autocommit.",
                    kind.past_tense()
                ),
                structured,
            ))
        }
        ManagedRoutineMutationResult::Conflict {
            current_fingerprint,
        } => Ok(mutation_error(
            if current_fingerprint.is_some() {
                "ROUTINE_FINGERPRINT_CONFLICT"
            } else {
                "ROUTINE_NOT_FOUND"
            },
            if current_fingerprint.is_some() {
                "routine definition changed after it was read"
            } else {
                "routine was not found for the explicit owner"
            },
            json!({ "currentFingerprint": current_fingerprint }),
        )),
        ManagedRoutineMutationResult::NameConflict { conflict } => Ok(mutation_error(
            "ROUTINE_NAME_CONFLICT",
            "routine name is already used inside the explicit owner",
            json!({
                "owner": conflict.owner,
                "conflicts": conflict.conflicts,
            }),
        )),
        ManagedRoutineMutationResult::Blocked {
            code,
            message,
            diagnostics,
        } => Ok(mutation_error(
            code.as_str(),
            &message,
            json!({ "diagnostics": diagnostics }),
        )),
    }
}

fn mutation_error(code: &str, message: &str, evidence: Value) -> ToolCallResult {
    let mut error = serde_json::Map::from_iter([
        ("code".into(), Value::String(code.into())),
        ("message".into(), Value::String(message.into())),
    ]);
    if let Value::Object(evidence) = evidence {
        error.extend(evidence);
    }
    ToolCallResult {
        content: vec![ContentBlock::text(message)],
        structured_content: Some(json!({ "error": error })),
        is_error: true,
    }
}

fn validate_mutation_identity(
    routine_id: &str,
    expected_fingerprint: &str,
) -> Result<(), ToolError> {
    if routine_id.is_empty() || routine_id.trim() != routine_id {
        return Err(ToolError::new(
            "INVALID_ROUTINE_ID",
            "routineId must be a non-empty exact id from list_routines",
        ));
    }
    if expected_fingerprint.is_empty() || expected_fingerprint.trim() != expected_fingerprint {
        return Err(ToolError::new(
            "INVALID_ROUTINE_FINGERPRINT",
            "expectedFingerprint must be a non-empty exact fingerprint from a Routine read",
        ));
    }
    Ok(())
}

fn resolve_routine_owner(
    target: &RequestTarget,
    space_id: &str,
    collection_path: Option<&str>,
) -> Result<ResolvedRoutineOwner, ToolError> {
    if space_id.is_empty() || space_id.trim() != space_id {
        return Err(ToolError::new(
            "INVALID_SPACE_ID",
            "spaceId must be a non-empty explicit id from list_spaces",
        ));
    }
    let collection_path = collection_path
        .map(validate_routine_collection_path)
        .transpose()?;
    let space = resolve_space(target, Some(space_id))?;
    let (owner_kind, owner_path) = match collection_path {
        Some(path) => (RoutineOwnerInputKind::CollectionDirectory, path),
        None => (RoutineOwnerInputKind::RegisteredSpace, ".".to_string()),
    };
    Ok(service::resolve_owner(
        Path::new(&target.project_path),
        Path::new(&space),
        space_id,
        &owner_path,
        owner_kind,
    )?)
}

fn validate_routine_collection_path(path: &str) -> Result<String, ToolError> {
    let path = validate_public_rel_path(path, false)?;
    if path
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case(".routines"))
    {
        return Err(ToolError::new(
            "PATH_FORBIDDEN",
            ".routines is not a public Routine owner address",
        ));
    }
    Ok(path)
}

fn authority_projection(result: Result<bool, RoutineServiceError>) -> AuthorityProjection {
    match result {
        Ok(enabled) => AuthorityProjection {
            enabled: Some(enabled),
            diagnostics: Vec::new(),
        },
        Err(error) => {
            tracing::warn!("routine automatic authority read failed for MCP: {error}");
            AuthorityProjection {
                enabled: None,
                diagnostics: vec![json!({
                    "code": AUTHORITY_UNAVAILABLE_CODE,
                    "message": "Routine definitions were read, but exact-owner automatic authority is unavailable on this device."
                })],
            }
        }
    }
}

fn list_payload(
    snapshot: &RoutineCatalogSnapshot,
    authority: AuthorityProjection,
    limit: Option<i64>,
    offset_arg: Option<i64>,
) -> Value {
    let limit = clamp_limit(limit) as usize;
    let offset = offset(offset_arg);
    let total = snapshot.routines.len();
    let routines = snapshot
        .routines
        .iter()
        .skip(offset)
        .take(limit)
        .map(summary_payload)
        .collect::<Vec<_>>();
    let has_more = offset.saturating_add(routines.len()) < total;
    json!({
        "owner": snapshot.owner,
        "catalogFingerprint": snapshot.catalog_fingerprint,
        "refreshedAt": snapshot.refreshed_at,
        "total": total,
        "offset": offset,
        "limit": limit,
        "hasMore": has_more,
        "automaticAuthorityEnabled": authority.enabled,
        "authorityDiagnostics": authority.diagnostics,
        "diagnostics": snapshot.diagnostics,
        "routines": routines,
    })
}

fn summary_payload(row: &RoutineRow) -> Value {
    json!({
        "routineId": row.routine_id,
        "filename": row.filename,
        "path": row.path,
        "name": row.name,
        "nameConflict": row.name_conflict,
        "description": row.description,
        "triggerType": row.trigger_type,
        "triggerSummary": row.trigger_summary,
        "actionType": row.action_type,
        "actionSummary": row.action_summary,
        "executor": row.executor,
        "enabled": row.enabled,
        "valid": row.routine_id.is_some() && row.definition.is_some() && row.diagnostics.is_empty(),
        "fingerprint": row.fingerprint,
        "diagnostics": row.diagnostics,
        "lastRunAt": row.last_run_at,
        "lastRunOrigin": row.last_run_origin,
        "nextRunAt": row.next_run_at,
    })
}

fn detail_payload(
    snapshot: &RoutineCatalogSnapshot,
    row: &RoutineRow,
    authority: AuthorityProjection,
) -> Value {
    json!({
        "owner": snapshot.owner,
        "catalogFingerprint": snapshot.catalog_fingerprint,
        "refreshedAt": snapshot.refreshed_at,
        "routineId": row.routine_id,
        "filename": row.filename,
        "path": row.path,
        "name": row.name,
        "nameConflict": row.name_conflict,
        "description": row.description,
        "definition": row.definition,
        "fingerprint": row.fingerprint,
        "valid": row.routine_id.is_some() && row.definition.is_some() && row.diagnostics.is_empty(),
        "diagnostics": row.diagnostics,
        "automaticAuthorityEnabled": authority.enabled,
        "authorityDiagnostics": authority.diagnostics,
        "lastRunAt": row.last_run_at,
        "lastRunOrigin": row.last_run_origin,
        "nextRunAt": row.next_run_at,
    })
}

fn find_routine<'a>(
    snapshot: &'a RoutineCatalogSnapshot,
    routine_id: &str,
) -> Result<&'a RoutineRow, ToolError> {
    snapshot
        .routines
        .iter()
        .find(|row| row.routine_id.as_deref() == Some(routine_id))
        .ok_or_else(|| {
            ToolError::new(
                "ROUTINE_NOT_FOUND",
                format!("routine {routine_id} was not found for the explicit owner"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::decode;
    use crate::host::RoutineCaller;
    use svode_core::routines::model::{
        RoutineAction, RoutineDiagnostic, RoutineOwnerDescriptor, RoutineOwnerKind,
        RoutineRunOrigin, RoutineTrigger, RoutineTriggerType,
    };

    fn row(id: &str, body: Option<&str>) -> RoutineRow {
        let definition = body.map(|body| RoutineDefinition {
            name: Some(id.into()),
            description: Some("description".into()),
            enabled: None,
            trigger: RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            },
            body: body.into(),
        });
        RoutineRow {
            routine_id: body.map(|_| id.into()),
            portable_id: body.map(|_| "01arz3ndektsv4rrffq69g5fav".into()),
            filename: format!("{id}.md"),
            path: format!(".routines/{id}.md"),
            name: id.into(),
            name_conflict: None,
            description: Some("description".into()),
            enabled: None,
            trigger_type: definition.as_ref().map(|_| RoutineTriggerType::Manual),
            trigger_summary: definition.as_ref().map(|_| "manual".into()),
            action_type: definition
                .as_ref()
                .map(|definition| definition.action.kind()),
            action_summary: definition.as_ref().map(|_| "run_agent".into()),
            executor: definition
                .as_ref()
                .and_then(|definition| definition.action.executor().map(ToOwned::to_owned)),
            last_run_at: Some("2026-08-20T00:00:00Z".into()),
            last_run_origin: Some(RoutineRunOrigin::Local),
            next_run_at: None,
            last_run: None,
            fingerprint: format!("fingerprint-{id}"),
            execution_fingerprint: format!("execution-{id}"),
            diagnostics: definition
                .is_none()
                .then(|| RoutineDiagnostic {
                    code: "routine_frontmatter_invalid".into(),
                    message: "invalid frontmatter".into(),
                    field: None,
                    path: Some(format!(".routines/{id}.md")),
                })
                .into_iter()
                .collect(),
            definition,
        }
    }

    fn snapshot(rows: Vec<RoutineRow>) -> RoutineCatalogSnapshot {
        RoutineCatalogSnapshot {
            owner: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: "root".into(),
                owner_path: ".".into(),
            },
            routines: rows,
            diagnostics: Vec::new(),
            catalog_fingerprint: "catalog".into(),
            refreshed_at: "2026-08-20T00:00:00Z".into(),
        }
    }

    fn target(routine_caller: Option<RoutineCaller>) -> RequestTarget {
        RequestTarget {
            project_path: "/project".into(),
            default_space_id: None,
            default_space_path: "/project".into(),
            routine_caller,
        }
    }

    #[test]
    fn explicit_space_id_is_required_and_unknown_fields_are_rejected() {
        assert!(decode::<ListRoutinesArgs>(json!({})).is_err());
        assert!(decode::<ListRoutinesArgs>(json!({ "spaceId": null })).is_err());
        assert!(decode::<GetRoutineArgs>(json!({ "spaceId": "root" })).is_err());
        assert!(
            decode::<ListRoutinesArgs>(json!({
                "spaceId": "root",
                "unexpected": true
            }))
            .is_err()
        );

        let definition = json!({
            "name": "Agent task",
            "trigger": { "type": "manual" },
            "action": {
                "type": "run_agent",
                "executor": "agent:01arz3ndektsv4rrffq69g5fav"
            },
            "body": "Do the task."
        });
        assert!(
            decode::<CreateRoutineArgs>(json!({
                "spaceId": "root",
                "definition": definition.clone(),
            }))
            .is_ok()
        );
        assert!(
            decode::<CreateRoutineArgs>(json!({
                "spaceId": "root",
                "definition": {
                    "trigger": { "type": "manual", "unexpected": true },
                    "action": {
                        "type": "run_agent",
                        "executor": "agent:01arz3ndektsv4rrffq69g5fav"
                    },
                    "body": ""
                }
            }))
            .is_err()
        );
        assert!(
            decode::<CreateRoutineArgs>(json!({
                "spaceId": "root",
                "definition": {
                    "trigger": { "type": "manual" },
                    "action": {
                        "type": "run_agent",
                        "executor": "agent:01arz3ndektsv4rrffq69g5fav"
                    }
                }
            }))
            .is_err()
        );
        assert!(
            decode::<UpdateRoutineArgs>(json!({
                "spaceId": "root",
                "routineId": "routine:one",
                "definition": definition,
            }))
            .is_err()
        );
        assert!(
            decode::<DeleteRoutineArgs>(json!({
                "spaceId": "root",
                "routineId": "routine:one",
                "expectedFingerprint": "fingerprint",
                "unexpected": true,
            }))
            .is_err()
        );
        assert!(
            decode::<RunRoutineArgs>(json!({
                "spaceId": "root",
                "routineId": "routine:one",
                "expectedFingerprint": "fingerprint",
            }))
            .is_ok()
        );
        assert!(
            decode::<RunRoutineArgs>(json!({
                "spaceId": "root",
                "routineId": "routine:one",
            }))
            .is_err()
        );
        assert!(
            decode::<RunRoutineArgs>(json!({
                "spaceId": "root",
                "routineId": "routine:one",
                "expectedFingerprint": "fingerprint",
                "routineCallerToken": "opaque-token",
            }))
            .is_err()
        );
    }

    #[test]
    fn verified_routine_provenance_selects_recursive_mutation_policy() {
        assert_eq!(
            mutation_policy(&target(None), true),
            RoutineMutationPolicyContext {
                origin: RoutineMutationOrigin::ExternalAgent,
                automatic_execution_acknowledged: true,
            }
        );
        let caller = RoutineCaller {
            routine_run_id: "run-one".into(),
            launch_id: "launch-one".into(),
            pty_id: "pty-one".into(),
        };
        assert_eq!(
            mutation_policy(&target(Some(caller)), true),
            RoutineMutationPolicyContext {
                origin: RoutineMutationOrigin::RoutineAgent,
                automatic_execution_acknowledged: true,
            }
        );
    }

    #[test]
    fn explicit_dispatch_result_preserves_identity_and_stable_blocks() {
        let already_running = dispatch_result(RoutineDispatchResult::AlreadyRunning {
            routine_id: "routine:one".into(),
            routine_run_id: "run-one".into(),
            launch_id: "launch-one".into(),
            agent_session_id: "codex:session-one".into(),
            source_session_id: Some("session-one".into()),
            pty_id: Some("pty-one".into()),
        });
        let structured = already_running.structured_content.unwrap();
        assert_eq!(structured["status"], "already_running");
        assert_eq!(structured["routineRunId"], "run-one");
        assert_eq!(structured["agentSessionId"], "codex:session-one");

        let conflict = dispatch_result(RoutineDispatchResult::Blocked {
            routine_id: "routine:one".into(),
            code: RoutineDispatchBlockedCode::FingerprintConflict,
            message: "changed".into(),
            current_fingerprint: Some("current".into()),
        });
        let structured = conflict.structured_content.unwrap();
        assert_eq!(structured["status"], "blocked");
        assert_eq!(structured["code"], "ROUTINE_FINGERPRINT_CONFLICT");
        assert_eq!(structured["currentFingerprint"], "current");

        let recursive = dispatch_result(RoutineDispatchResult::Blocked {
            routine_id: "routine:one".into(),
            code: RoutineDispatchBlockedCode::RecursionGuard,
            message: "recursive".into(),
            current_fingerprint: None,
        });
        assert_eq!(
            recursive.structured_content.unwrap()["code"],
            "ROUTINE_RECURSION_GUARD"
        );
    }

    #[test]
    fn mutation_errors_keep_stable_code_and_recovery_evidence() {
        let conflict = mutation_error(
            "ROUTINE_FINGERPRINT_CONFLICT",
            "changed",
            json!({ "currentFingerprint": "current" }),
        );
        assert!(conflict.is_error);
        assert_eq!(
            conflict.structured_content.as_ref().unwrap()["error"]["code"],
            "ROUTINE_FINGERPRINT_CONFLICT"
        );
        assert_eq!(
            conflict.structured_content.as_ref().unwrap()["error"]["currentFingerprint"],
            "current"
        );

        let blocked = mutation_error(
            "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED",
            "confirm",
            json!({ "diagnostics": [] }),
        );
        assert_eq!(
            blocked.structured_content.as_ref().unwrap()["error"]["code"],
            "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED"
        );
        assert_eq!(blocked.content[0].text, "confirm");

        let name_conflict = mutation_error(
            "ROUTINE_NAME_CONFLICT",
            "name conflict",
            json!({
                "owner": { "kind": "project", "spaceId": "root", "ownerPath": "." },
                "conflicts": [{
                    "routineId": "routine:one",
                    "name": "One",
                    "filename": "one.md",
                    "path": ".routines/one.md"
                }]
            }),
        );
        let name_error = &name_conflict.structured_content.as_ref().unwrap()["error"];
        assert_eq!(name_error["code"], "ROUTINE_NAME_CONFLICT");
        assert_eq!(name_error["owner"]["ownerPath"], ".");
        assert_eq!(name_error["conflicts"][0]["path"], ".routines/one.md");

        assert!(validate_mutation_identity("routine:one", "fingerprint").is_ok());
        assert_eq!(
            validate_mutation_identity(" ", "fingerprint")
                .unwrap_err()
                .code,
            "INVALID_ROUTINE_ID"
        );
        assert_eq!(
            validate_mutation_identity("routine:one", "")
                .unwrap_err()
                .code,
            "INVALID_ROUTINE_FINGERPRINT"
        );
    }

    #[test]
    fn collection_address_rejects_absolute_traversal_and_raw_routines_paths() {
        for path in [
            "/tasks",
            "../tasks",
            "tasks/../other",
            ".routines",
            ".ROUTINES/x",
            "tasks/.routines",
            "tasks/.ROUTINES/nested",
        ] {
            assert!(validate_routine_collection_path(path).is_err(), "{path}");
        }
        assert_eq!(validate_routine_collection_path("tasks").unwrap(), "tasks");
    }

    #[test]
    fn pagination_defaults_and_clamps_to_the_public_bound() {
        let rows = (0..205)
            .map(|index| row(&format!("routine-{index}"), Some("body")))
            .collect::<Vec<_>>();
        let defaults = list_payload(
            &snapshot(rows.clone()),
            authority_projection(Ok(false)),
            None,
            None,
        );
        assert_eq!(defaults["limit"], 50);
        assert_eq!(defaults["offset"], 0);
        let minimum = list_payload(
            &snapshot(rows.clone()),
            authority_projection(Ok(false)),
            Some(0),
            Some(-1),
        );
        assert_eq!(minimum["limit"], 1);
        assert_eq!(minimum["offset"], 0);

        let payload = list_payload(
            &snapshot(rows),
            authority_projection(Ok(false)),
            Some(500),
            Some(5),
        );
        assert_eq!(payload["limit"], 200);
        assert_eq!(payload["offset"], 5);
        assert_eq!(payload["routines"].as_array().unwrap().len(), 200);
        assert_eq!(payload["hasMore"], false);
    }

    #[test]
    fn list_is_bodyless_and_keeps_valid_and_malformed_siblings_visible() {
        let payload = list_payload(
            &snapshot(vec![
                row("valid", Some("secret body")),
                row("invalid", None),
            ]),
            authority_projection(Ok(true)),
            None,
            None,
        );
        let rows = payload["routines"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].get("definition").is_none());
        assert!(!rows[0].to_string().contains("secret body"));
        assert_eq!(rows[0]["valid"], true);
        assert_eq!(rows[1]["valid"], false);
        assert_eq!(rows[1]["routineId"], Value::Null);
        assert_eq!(payload["automaticAuthorityEnabled"], true);
    }

    #[test]
    fn detail_preserves_normalized_body_and_unknown_id_has_stable_error() {
        let snapshot = snapshot(vec![row("valid", Some("# Normalized body\n"))]);
        let row = find_routine(&snapshot, "valid").unwrap();
        let payload = detail_payload(&snapshot, row, authority_projection(Ok(false)));
        assert_eq!(payload["definition"]["body"], "# Normalized body\n");
        assert_eq!(payload["automaticAuthorityEnabled"], false);

        let error = find_routine(&snapshot, "missing").unwrap_err();
        assert_eq!(error.code, "ROUTINE_NOT_FOUND");
    }

    #[test]
    fn authority_on_off_and_unavailable_remain_distinct() {
        let on = authority_projection(Ok(true));
        assert_eq!(on.enabled, Some(true));
        assert!(on.diagnostics.is_empty());
        let off = authority_projection(Ok(false));
        assert_eq!(off.enabled, Some(false));
        assert!(off.diagnostics.is_empty());
        let unavailable =
            authority_projection(Err(RoutineServiceError::General("private detail".into())));
        assert_eq!(unavailable.enabled, None);
        assert_eq!(unavailable.diagnostics.len(), 1);
        assert_eq!(
            unavailable.diagnostics[0]["code"],
            AUTHORITY_UNAVAILABLE_CODE
        );
        assert!(
            !unavailable.diagnostics[0]
                .to_string()
                .contains("private detail")
        );
    }

    #[test]
    fn empty_owner_is_a_successful_empty_page() {
        let payload = list_payload(
            &snapshot(Vec::new()),
            authority_projection(Ok(false)),
            None,
            None,
        );
        assert_eq!(payload["total"], 0);
        assert_eq!(payload["routines"], json!([]));
        assert_eq!(payload["hasMore"], false);
    }
}
