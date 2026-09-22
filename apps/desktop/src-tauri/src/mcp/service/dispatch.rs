use super::*;

use std::future::Future;
use std::pin::Pin;

use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineDispatchResult};
use svode_core::storage::config::AssetsSpaceConfig;
use svode_mcp::host::{RoutineCaller, RoutineRunner, RoutineRuntime};

pub async fn call_tool(app: AppHandle, name: &str, args: Value) -> ToolCallResult {
    call_tool_with_context(app, name, args, None).await
}

pub async fn call_tool_with_context(
    app: AppHandle,
    name: &str,
    args: Value,
    context_override: Option<IpcContextOverride>,
) -> ToolCallResult {
    let resolved_context =
        match super::context::resolve_context_override(&app, context_override.as_ref()) {
            Ok(context) => context,
            Err(error) => return ToolCallResult::business_error(error),
        };

    // Freeze the desktop active context for the whole request. The request
    // resolves the same active Space even if the user changes selection
    // while the tool call is in flight.
    let request_context =
        freeze_request_context(resolved_context, &app.state::<ActiveProjectState>());

    let routine_caller =
        match resolve_routine_caller(&app, context_override.as_ref(), request_context.as_ref()) {
            Ok(provenance) => provenance,
            Err(error) => return ToolCallResult::business_error(error),
        };
    let target = request_context
        .as_ref()
        .map(|context| request_target(context, routine_caller));
    let host = DesktopMcpHost { app };
    svode_mcp::dispatch::call_tool(&host, target.as_ref(), name, args).await
}

/// Desktop host of the shared MCP mapping: active-context resolution happens
/// before dispatch, runtime handles come from managed state.
pub(crate) struct DesktopMcpHost {
    pub(crate) app: AppHandle,
}

impl svode_mcp::host::McpHost for DesktopMcpHost {
    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    fn serves_tool(&self, _name: &str) -> bool {
        true
    }

    async fn index_pool(
        &self,
        key: &svode_core::index::IndexKey,
        space_path: &Path,
    ) -> Option<sqlx::SqlitePool> {
        let state = self.app.state::<IndexState>();
        if let Ok(pool) = state.get_or_create(key).await {
            return Some(pool);
        }
        let fallback = state
            .key_for_space_dir(space_path)
            .await
            .unwrap_or_else(|| svode_core::index::IndexKey::Root(space_path.to_path_buf()));
        state.get_or_create(&fallback).await.ok()
    }

    async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<svode_core::git::access::RepositoryAccessSnapshot, McpBusinessError> {
        crate::git::access::repository_access_snapshot(&self.app, space_path)
            .await
            .map_err(Into::into)
    }

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), McpBusinessError> {
        crate::git::access::require_repository_mutation(&self.app, repository)
            .await
            .map(|_| ())
            .map_err(Into::into)
    }

    fn read_runtime(&self) -> svode_mcp::host::ReadRuntime<'_> {
        svode_mcp::host::ReadRuntime {
            index: &self.app.state::<IndexState>().inner().core,
            actors: self.app.state::<crate::actors::ActorCatalogState>().inner(),
            git: self.app.state::<GitState>().inner().runtime(),
        }
    }

    fn mutation_runtime(&self) -> svode_mcp::host::MutationRuntime<'_> {
        svode_mcp::host::MutationRuntime {
            index: &self.app.state::<IndexState>().inner().core,
            updates: self.app.state::<IndexUpdateState>().inner().core(),
            nonces: self
                .app
                .state::<std::sync::Arc<svode_core::page::nonce::WriteNonceRegistry>>()
                .inner(),
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        Some(self)
    }

    fn deliver_managed_import(&self, delivery: &ManagedImportDelivery) {
        crate::attachments::delivery::emit_managed_import_invalidations(&self.app, delivery);
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, McpBusinessError> {
        Ok(RoutineRuntime {
            stores: self
                .app
                .state::<std::sync::Arc<crate::routines::RoutineStoreState>>()
                .inner()
                .core(),
            live_evidence: crate::routines::runtime::live_evidence(
                &self.app.state::<crate::terminal::TerminalManager>(),
            )?,
        })
    }

    fn deliver_routine_invalidation(&self, owner: &ResolvedRoutineOwner) {
        crate::routines::emit_owner_invalidation(&self.app, owner);
    }

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        Some(self)
    }
}

/// Explicit Routine launches go through the Desktop dispatch/PTY owner.
impl RoutineRunner for DesktopMcpHost {
    fn run(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
        expected_fingerprint: String,
    ) -> Pin<Box<dyn Future<Output = Result<RoutineDispatchResult, McpBusinessError>> + Send + '_>>
    {
        Box::pin(async move {
            crate::routines::dispatch::dispatch_explicit(
                &self.app,
                owner,
                routine_id,
                Some(expected_fingerprint),
                &self.app.state::<GitState>(),
                &self
                    .app
                    .state::<crate::git::access::RepositoryAccessState>(),
                &self
                    .app
                    .state::<std::sync::Arc<crate::routines::RoutineStoreState>>(),
                &self.app.state::<IndexState>(),
                &self.app.state::<crate::terminal::TerminalManager>(),
            )
            .await
            .map_err(Into::into)
        })
    }
}

/// Managed imports see the live readiness of the configured Git LFS backend.
impl LfsReadiness for DesktopMcpHost {
    fn lfs_ready<'a>(
        &'a self,
        repo_dir: &'a Path,
        config: &'a AssetsSpaceConfig,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(crate::attachments::import::lfs_ready(
            self.app.state::<GitState>().inner(),
            repo_dir,
            config,
        ))
    }
}

fn resolve_routine_caller(
    app: &AppHandle,
    context_override: Option<&IpcContextOverride>,
    request_context: Option<&ActiveProjectContext>,
) -> Result<Option<RoutineCaller>, McpBusinessError> {
    let Some(token) = context_override
        .and_then(|context| context.routine_caller_token.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let context = request_context.ok_or_else(|| {
        McpBusinessError::new(
            "ROUTINE_CALLER_PROVENANCE_INVALID",
            "routine caller provenance has no frozen Svode project context",
        )
    })?;
    app.state::<crate::terminal::TerminalManager>()
        .resolve_routine_mcp_caller(token, Path::new(&context.project_path))?
        .ok_or_else(|| {
            McpBusinessError::new(
                "ROUTINE_CALLER_PROVENANCE_INVALID",
                "routine caller provenance is not attached to a live managed Routine launch in this project",
            )
        })
        .map(Some)
}

fn freeze_request_context(
    resolved_context: Option<ActiveProjectContext>,
    active_state: &ActiveProjectState,
) -> Option<ActiveProjectContext> {
    resolved_context.or_else(|| active_state.get())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(space_id: &str) -> ActiveProjectContext {
        ActiveProjectContext {
            project_path: "/project".to_string(),
            active_space_id: Some(space_id.to_string()),
            active_space_path: format!("/project/{space_id}"),
        }
    }

    #[test]
    fn desktop_selection_change_does_not_replace_frozen_request_context() {
        let state = ActiveProjectState::new();
        state.set(context("first"));
        let target = freeze_request_context(None, &state)
            .map(|context| request_target(&context, None))
            .unwrap();

        state.set(context("second"));

        assert_eq!(target.default_space_id.as_deref(), Some("first"));
        assert_eq!(target.default_space_path, "/project/first");
        assert_eq!(
            state.get().unwrap().active_space_id.as_deref(),
            Some("second")
        );
    }

    #[test]
    fn explicit_caller_context_wins_over_desktop_selection() {
        let state = ActiveProjectState::new();
        state.set(context("desktop"));

        let frozen = freeze_request_context(Some(context("caller")), &state).unwrap();

        assert_eq!(frozen.active_space_id.as_deref(), Some("caller"));
    }
}
