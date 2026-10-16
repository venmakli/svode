//! Agent Actors of one explicit Space: the executor domain of its Routine
//! owners, from the one core resolution Routine validation uses.
//!
//! The answer is the portable catalog: no device paths, approval modes or
//! binding readiness, so the bridge and a standalone process agree.

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::agent_actors::{
    AgentActorCatalogDiagnostic, ResolvedAgentActor, resolve_space_catalogs,
};

use crate::error::ToolError;
use crate::host::RequestTarget;
use crate::result::ToolCallResult;
use crate::target::ROOT_SPACE_ID;
use crate::tools::routines::resolve_routine_owner;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListAgentActorsArgs {
    space_id: String,
}

pub(crate) fn list_agent_actors(
    target: &RequestTarget,
    args: ListAgentActorsArgs,
) -> Result<ToolCallResult, ToolError> {
    let owner = resolve_routine_owner(target, &args.space_id, None)?;
    let resolution = resolve_space_catalogs(&owner.project_path, &owner.space_path);
    let space_path = owner.space_path.to_string_lossy();
    let owner_space_id = |owner_path: &str| {
        if owner_path == space_path {
            args.space_id.as_str()
        } else {
            ROOT_SPACE_ID
        }
    };
    let agents = resolution
        .actors
        .iter()
        .map(|resolved| agent(resolved, owner_space_id(&resolved.owner_path)))
        .collect::<Vec<_>>();
    let diagnostics = resolution
        .diagnostics
        .iter()
        .map(|diagnostic| catalog_diagnostic(diagnostic, owner_space_id(&diagnostic.owner_path)))
        .collect::<Vec<_>>();
    let mut summary = format!(
        "Found {} Agent Actors for Space {}.",
        agents.len(),
        args.space_id
    );
    if !diagnostics.is_empty() {
        summary.push_str(&format!(
            " {} catalog diagnostics: the list may be incomplete.",
            diagnostics.len()
        ));
    }
    Ok(ToolCallResult::ok(
        summary,
        json!({
            "spaceId": args.space_id,
            "agents": agents,
            "diagnostics": diagnostics,
        }),
    ))
}

fn agent(resolved: &ResolvedAgentActor, owner_space_id: &str) -> Value {
    let actor = &resolved.actor;
    json!({
        "reference": format!("agent:{}", actor.id),
        "name": actor.name,
        "description": actor.description,
        "ownerSpaceId": owner_space_id,
        "bindings": actor
            .adapters
            .iter()
            .map(|binding| json!({
                "adapter": binding.adapter.as_str(),
                "model": binding.model,
                "effort": binding.effort,
            }))
            .collect::<Vec<_>>(),
    })
}

fn catalog_diagnostic(diagnostic: &AgentActorCatalogDiagnostic, owner_space_id: &str) -> Value {
    json!({
        "code": diagnostic.code,
        "ownerSpaceId": owner_space_id,
        "reference": diagnostic.actor_id.as_ref().map(|id| format!("agent:{id}")),
        "message": diagnostic.message,
    })
}
