use super::*;

use std::future::Future;
use std::pin::Pin;

use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineDispatchResult};
use svode_tools::host::{RoutineCaller, RoutineRunner, RoutineRuntime};

use crate::mcp::project_sessions::{ProjectSessions, RequestSession};

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
    let host = DesktopMcpHost::new(app);
    if let Some(target) = &target {
        host.session
            .attach_existing(
                &host.app.state::<ProjectSessions>(),
                host.desktop_index(),
                Path::new(&target.project_path),
            )
            .await;
    }
    svode_tools::dispatch::call_tool(&host, target.as_ref(), name, args).await
}

/// Desktop host of the shared MCP mapping: active-context resolution happens
/// before dispatch, runtime handles come from managed state. The index of a
/// target project no window has open comes from its on-demand session.
pub(crate) struct DesktopMcpHost {
    pub(crate) app: AppHandle,
    session: RequestSession,
}

impl DesktopMcpHost {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            session: RequestSession::default(),
        }
    }

    fn desktop_index(&self) -> &svode_core::index::state::IndexRuntimeState {
        &self.app.state::<IndexState>().inner().core
    }
}

impl svode_tools::host::ToolHost for DesktopMcpHost {
    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    fn serves_tool(&self, _name: &str) -> bool {
        true
    }

    async fn prepare_mutation(&self, paths: &[PathBuf]) {
        self.session.prepare_mutation(paths).await;
    }

    async fn prepare_index(
        &self,
        project: &Path,
        scope: &svode_core::index::knowledge::KnowledgeScope,
    ) -> Result<svode_core::index::freshness::IndexFreshness, ToolError> {
        self.session
            .prepare_index(
                &self.app.state::<ProjectSessions>(),
                self.desktop_index(),
                project,
                scope,
            )
            .await
    }

    /// Only a pool the project runtime or the request session opened: a
    /// request never creates an empty index here.
    async fn index_pool(
        &self,
        key: &svode_core::index::IndexKey,
        space_path: &Path,
    ) -> Option<sqlx::SqlitePool> {
        self.session
            .index_pool(self.desktop_index(), key, space_path)
            .await
    }

    async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<svode_core::git::access::RepositoryAccessSnapshot, ToolError> {
        crate::git::access::repository_access_snapshot(&self.app, space_path)
            .await
            .map_err(Into::into)
    }

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), ToolError> {
        crate::git::access::require_repository_mutation(&self.app, repository)
            .await
            .map(|_| ())
            .map_err(Into::into)
    }

    fn read_runtime(&self) -> svode_tools::host::ReadRuntime<'_> {
        svode_tools::host::ReadRuntime {
            index: self.session.index(self.desktop_index()),
            actors: self.app.state::<crate::actors::ActorCatalogState>().inner(),
            git: self.app.state::<GitState>().inner().runtime(),
        }
    }

    fn mutation_runtime(&self) -> svode_tools::host::MutationRuntime<'_> {
        self.session
            .mutation_runtime(svode_tools::host::MutationRuntime {
                index: self.desktop_index(),
                updates: self.app.state::<IndexUpdateState>().inner().core(),
                nonces: self
                    .app
                    .state::<std::sync::Arc<svode_core::page::nonce::WriteNonceRegistry>>()
                    .inner(),
            })
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        Some(self.app.state::<GitState>().inner().runtime().as_ref())
    }

    fn deliver_managed_import(&self, delivery: &ManagedImportDelivery) {
        crate::attachments::delivery::emit_managed_import_invalidations(&self.app, delivery);
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
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
    ) -> Pin<Box<dyn Future<Output = Result<RoutineDispatchResult, ToolError>> + Send + '_>> {
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

fn resolve_routine_caller(
    app: &AppHandle,
    context_override: Option<&IpcContextOverride>,
    request_context: Option<&ActiveProjectContext>,
) -> Result<Option<RoutineCaller>, ToolError> {
    let Some(token) = context_override
        .and_then(|context| context.routine_caller_token.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let context = request_context.ok_or_else(|| {
        ToolError::new(
            "ROUTINE_CALLER_PROVENANCE_INVALID",
            "routine caller provenance has no frozen Svode project context",
        )
    })?;
    app.state::<crate::terminal::TerminalManager>()
        .resolve_routine_mcp_caller(token, Path::new(&context.project_path))?
        .ok_or_else(|| {
            ToolError::new(
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
