use super::*;
use crate::AppError;
use crate::routines::{
    ResolvedRoutineOwner, RoutineCatalogSnapshot, RoutineDefinition, RoutineDispatchBlockedCode,
    RoutineDispatchResult, RoutineOwnerInputKind, RoutineRow,
};
use crate::terminal::TerminalManager;

const DEFAULT_ROUTINE_LIMIT: i64 = 50;
const MAX_ROUTINE_LIMIT: i64 = 200;
const AUTHORITY_UNAVAILABLE_CODE: &str = "routine_authority_unavailable";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ListRoutinesArgs {
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
pub(super) struct GetRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    routine_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateRoutineArgs {
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
pub(super) struct UpdateRoutineArgs {
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
pub(super) struct DeleteRoutineArgs {
    space_id: String,
    #[serde(default)]
    collection_path: Option<String>,
    routine_id: String,
    expected_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunRoutineArgs {
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
                &["type", "cron", "timezone", "missedRuns"],
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

pub(super) async fn list_routines(
    app: &AppHandle,
    args: ListRoutinesArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let owner = resolve_routine_owner(app, &args.space_id, args.collection_path.as_deref()).await?;
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    let snapshot =
        crate::routines::service::read_catalog(&index_state, &terminal_manager, &owner).await?;
    let authority = authority_projection(
        crate::routines::service::read_automatic_authority(&index_state, &owner).await,
    );
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

pub(super) async fn get_routine(
    app: &AppHandle,
    args: GetRoutineArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let owner = resolve_routine_owner(app, &args.space_id, args.collection_path.as_deref()).await?;
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    let snapshot =
        crate::routines::service::read_catalog(&index_state, &terminal_manager, &owner).await?;
    let row = find_routine(&snapshot, &args.routine_id)?;
    let authority = authority_projection(
        crate::routines::service::read_automatic_authority(&index_state, &owner).await,
    );
    Ok(ToolCallResult::ok(
        format!("Read routine {} for the explicit owner.", args.routine_id),
        detail_payload(&snapshot, row, authority),
    ))
}

pub(super) async fn create_routine(
    app: &AppHandle,
    args: CreateRoutineArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let owner = resolve_routine_owner(app, &args.space_id, args.collection_path.as_deref()).await?;
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    let git_state = app.state::<GitState>();
    let access_state = app.state::<crate::git::access::RepositoryAccessState>();
    let result = crate::routines::service::create_managed(
        app,
        owner.clone(),
        args.definition,
        mutation_policy(args.confirm_automatic_execution.unwrap_or(false)),
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await?;
    mutation_result(app, &owner, result, MutationKind::Create).await
}

pub(super) async fn update_routine(
    app: &AppHandle,
    args: UpdateRoutineArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    validate_mutation_identity(&args.routine_id, &args.expected_fingerprint)?;
    let owner = resolve_routine_owner(app, &args.space_id, args.collection_path.as_deref()).await?;
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    let git_state = app.state::<GitState>();
    let access_state = app.state::<crate::git::access::RepositoryAccessState>();
    let result = crate::routines::service::update_managed(
        app,
        owner.clone(),
        args.routine_id,
        args.expected_fingerprint,
        args.definition,
        mutation_policy(args.confirm_automatic_execution.unwrap_or(false)),
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await?;
    mutation_result(app, &owner, result, MutationKind::Update).await
}

pub(super) async fn delete_routine(
    app: &AppHandle,
    args: DeleteRoutineArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    validate_mutation_identity(&args.routine_id, &args.expected_fingerprint)?;
    let owner = resolve_routine_owner(app, &args.space_id, args.collection_path.as_deref()).await?;
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    let git_state = app.state::<GitState>();
    let access_state = app.state::<crate::git::access::RepositoryAccessState>();
    let result = crate::routines::service::delete_managed(
        app,
        owner.clone(),
        args.routine_id,
        args.expected_fingerprint,
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await?;
    mutation_result(app, &owner, result, MutationKind::Delete).await
}

pub(super) async fn run_routine(
    app: &AppHandle,
    args: RunRoutineArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    validate_mutation_identity(&args.routine_id, &args.expected_fingerprint)?;
    if crate::mcp::service::routine_caller_provenance().is_some() {
        return Ok(dispatch_result(RoutineDispatchResult::Blocked {
            routine_id: args.routine_id,
            code: RoutineDispatchBlockedCode::RecursionGuard,
            message: "a routine-launched MCP caller cannot run a Routine".to_string(),
            current_fingerprint: None,
        }));
    }
    let owner = resolve_routine_owner(app, &args.space_id, args.collection_path.as_deref()).await?;
    let result = crate::routines::dispatch::dispatch_explicit(
        app,
        owner,
        args.routine_id,
        Some(args.expected_fingerprint),
        &app.state::<GitState>(),
        &app.state::<crate::git::access::RepositoryAccessState>(),
        &app.state::<IndexState>(),
        &app.state::<TerminalManager>(),
    )
    .await?;
    Ok(dispatch_result(result))
}

fn mutation_policy(
    confirm_automatic_execution: bool,
) -> crate::routines::service::RoutineMutationPolicy {
    if crate::mcp::service::routine_caller_provenance().is_some() {
        crate::routines::service::RoutineMutationPolicy::routine_mcp(confirm_automatic_execution)
    } else {
        crate::routines::service::RoutineMutationPolicy::external_mcp(confirm_automatic_execution)
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
    app: &AppHandle,
    owner: &ResolvedRoutineOwner,
    result: crate::routines::service::ManagedRoutineMutationResult,
    kind: MutationKind,
) -> Result<ToolCallResult, McpBusinessError> {
    match result {
        crate::routines::service::ManagedRoutineMutationResult::Applied {
            routine_id,
            snapshot,
            changed_paths,
            warnings,
        } => {
            let authority = authority_projection(
                crate::routines::service::read_automatic_authority(
                    &app.state::<IndexState>(),
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
        crate::routines::service::ManagedRoutineMutationResult::Conflict {
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
        crate::routines::service::ManagedRoutineMutationResult::NameConflict { conflict } => {
            Ok(mutation_error(
                "ROUTINE_NAME_CONFLICT",
                "routine name is already used inside the explicit owner",
                json!({
                    "owner": conflict.owner,
                    "conflicts": conflict.conflicts,
                }),
            ))
        }
        crate::routines::service::ManagedRoutineMutationResult::Blocked {
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
        content: vec![crate::mcp::protocol::ContentBlock::text(message)],
        structured_content: Some(json!({ "error": error })),
        is_error: true,
    }
}

fn validate_mutation_identity(
    routine_id: &str,
    expected_fingerprint: &str,
) -> Result<(), McpBusinessError> {
    if routine_id.is_empty() || routine_id.trim() != routine_id {
        return Err(McpBusinessError::new(
            "INVALID_ROUTINE_ID",
            "routineId must be a non-empty exact id from list_routines",
        ));
    }
    if expected_fingerprint.is_empty() || expected_fingerprint.trim() != expected_fingerprint {
        return Err(McpBusinessError::new(
            "INVALID_ROUTINE_FINGERPRINT",
            "expectedFingerprint must be a non-empty exact fingerprint from a Routine read",
        ));
    }
    Ok(())
}

async fn resolve_routine_owner(
    app: &AppHandle,
    space_id: &str,
    collection_path: Option<&str>,
) -> Result<ResolvedRoutineOwner, McpBusinessError> {
    if space_id.is_empty() || space_id.trim() != space_id {
        return Err(McpBusinessError::new(
            "INVALID_SPACE_ID",
            "spaceId must be a non-empty explicit id from list_spaces",
        ));
    }
    let collection_path = collection_path
        .map(validate_routine_collection_path)
        .transpose()?;
    let (context, space) = resolve_space(app, Some(space_id.to_string())).await?;
    let (owner_kind, owner_path) = match collection_path {
        Some(path) => (RoutineOwnerInputKind::CollectionDirectory, path),
        None => (RoutineOwnerInputKind::RegisteredSpace, ".".to_string()),
    };
    crate::routines::service::resolve_owner(
        Path::new(&context.project_path),
        Path::new(&space),
        space_id,
        &owner_path,
        owner_kind,
    )
    .map_err(Into::into)
}

fn validate_routine_collection_path(path: &str) -> Result<String, McpBusinessError> {
    let path = validate_public_rel_path(path, false)?;
    if path
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case(".routines"))
    {
        return Err(McpBusinessError::new(
            "PATH_FORBIDDEN",
            ".routines is not a public Routine owner address",
        ));
    }
    Ok(path)
}

fn authority_projection(result: Result<bool, AppError>) -> AuthorityProjection {
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
    offset: Option<i64>,
) -> Value {
    let (limit, offset) = bounded_page(limit, offset);
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
) -> Result<&'a RoutineRow, McpBusinessError> {
    snapshot
        .routines
        .iter()
        .find(|row| row.routine_id.as_deref() == Some(routine_id))
        .ok_or_else(|| {
            McpBusinessError::new(
                "ROUTINE_NOT_FOUND",
                format!("routine {routine_id} was not found for the explicit owner"),
            )
        })
}

fn bounded_page(limit: Option<i64>, offset: Option<i64>) -> (usize, usize) {
    (
        limit
            .unwrap_or(DEFAULT_ROUTINE_LIMIT)
            .clamp(1, MAX_ROUTINE_LIMIT) as usize,
        offset.unwrap_or(0).max(0) as usize,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routines::{
        RoutineAction, RoutineDefinition, RoutineDiagnostic, RoutineOwnerDescriptor,
        RoutineOwnerKind, RoutineRunOrigin, RoutineTrigger, RoutineTriggerType,
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
    }

    #[tokio::test]
    async fn verified_routine_provenance_selects_recursive_mutation_policy() {
        assert_eq!(
            mutation_policy(true),
            crate::routines::service::RoutineMutationPolicy::external_mcp(true)
        );

        super::super::MCP_ROUTINE_CALLER
            .scope(
                Some(crate::terminal::RoutineMcpCallerProvenance {
                    routine_run_id: "run-one".into(),
                    launch_id: "launch-one".into(),
                    pty_id: "pty-one".into(),
                }),
                async {
                    assert_eq!(
                        mutation_policy(true),
                        crate::routines::service::RoutineMutationPolicy::routine_mcp(true)
                    );
                },
            )
            .await;
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
        assert_eq!(bounded_page(None, None), (50, 0));
        assert_eq!(bounded_page(Some(500), Some(-1)), (200, 0));
        assert_eq!(bounded_page(Some(0), Some(4)), (1, 4));

        let rows = (0..205)
            .map(|index| row(&format!("routine-{index}"), Some("body")))
            .collect();
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
        let unavailable = authority_projection(Err(AppError::General("private detail".into())));
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
