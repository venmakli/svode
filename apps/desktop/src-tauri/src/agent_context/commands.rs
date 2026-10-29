use std::ffi::OsStr;
use std::path::PathBuf;

use tauri::State;
use tauri::ipc::Response;

use crate::AppError;

use super::state::AgentContextState;
use crate::agent_setup::AgentSetupState;
use crate::document::source::{
    DocumentSourceDescriptor, DocumentSourceError, inspect_local_document_source,
    read_local_document_source,
};
use crate::media::MediaSourceState;
use crate::media::commands::{MediaSourceSessionDescriptor, issue_local_media_source};
use crate::media::source::MediaSourceError;
use crate::process::login_env::LoginEnvironment;
use svode_core::agent_context::model::{AgentContextSnapshot, MarkdownPreview};
use svode_core::agent_context::scanner;
use svode_core::agent_context::scanner::skill_files::{self, SkillFileKind, SkillFilesBranch};

#[tauri::command]
pub async fn agent_context_get_items(
    state: State<'_, AgentContextState>,
    agents: State<'_, AgentSetupState>,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    discover_and_publish(&state, &agents, project_path, space_path).await
}

#[tauri::command]
pub async fn agent_context_refresh_items(
    state: State<'_, AgentContextState>,
    agents: State<'_, AgentSetupState>,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    discover_and_publish(&state, &agents, project_path, space_path).await
}

/// The supported files directly inside `path` of a skill folder; `path` is
/// empty for the folder itself. Only a skill of a published snapshot is read.
#[tauri::command]
pub async fn agent_context_list_skill_files(
    state: State<'_, AgentContextState>,
    item_id: String,
    path: String,
) -> Result<SkillFilesBranch, AppError> {
    let directory = skill_directory(&state, &item_id)?;
    tokio::task::spawn_blocking(move || skill_files::list_skill_files(&directory, &path))
        .await
        .map_err(|error| AppError::General(format!("skill files task failed: {error}")))?
        .map_err(AppError::from)
}

/// The text of a Markdown file of a skill, read within its folder.
#[tauri::command]
pub async fn agent_context_read_skill_file(
    state: State<'_, AgentContextState>,
    item_id: String,
    path: String,
) -> Result<MarkdownPreview, AppError> {
    let directory = skill_directory(&state, &item_id)?;
    tokio::task::spawn_blocking(move || skill_files::read_skill_markdown(&directory, &path))
        .await
        .map_err(|error| AppError::General(format!("skill file task failed: {error}")))?
        .map_err(AppError::from)
}

/// A document of a skill folder: only inside a skill of a published snapshot.
#[tauri::command]
pub(crate) async fn agent_context_inspect_skill_document(
    state: State<'_, AgentContextState>,
    item_id: String,
    path: String,
) -> Result<DocumentSourceDescriptor, DocumentSourceError> {
    let file = skill_file(&state, &item_id, &path, SkillFileKind::Document)
        .ok_or(DocumentSourceError::SourceInaccessible)?;
    tokio::task::spawn_blocking(move || inspect_local_document_source(&file))
        .await
        .map_err(|_| DocumentSourceError::SourceInaccessible)?
        .map(|resolved| resolved.descriptor)
}

#[tauri::command]
pub(crate) async fn agent_context_read_skill_document(
    state: State<'_, AgentContextState>,
    item_id: String,
    path: String,
    expected_generation: String,
) -> Result<Response, DocumentSourceError> {
    let file = skill_file(&state, &item_id, &path, SkillFileKind::Document)
        .ok_or(DocumentSourceError::SourceInaccessible)?;
    tokio::task::spawn_blocking(move || read_local_document_source(&file, &expected_generation))
        .await
        .map_err(|_| DocumentSourceError::SourceInaccessible)?
        .map(Response::new)
}

/// A media capability for a file of a skill folder, resolved inside it.
#[tauri::command]
pub(crate) fn agent_context_create_skill_media_source(
    state: State<'_, AgentContextState>,
    media: State<'_, MediaSourceState>,
    item_id: String,
    path: String,
) -> Result<MediaSourceSessionDescriptor, MediaSourceError> {
    let file = skill_file(&state, &item_id, &path, SkillFileKind::Media)
        .ok_or(MediaSourceError::SourceUnavailable)?;
    issue_local_media_source(&media, &file)
}

/// The canonical file of `kind` at `path` inside the folder of a published
/// skill; nothing outside it.
fn skill_file(
    state: &AgentContextState,
    item_id: &str,
    path: &str,
    kind: SkillFileKind,
) -> Option<PathBuf> {
    let directory = state.skill_directory(item_id)?;
    skill_files::resolve_skill_file(&directory, path, kind).ok()
}

fn skill_directory(state: &AgentContextState, item_id: &str) -> Result<PathBuf, AppError> {
    state.skill_directory(item_id).ok_or_else(|| {
        AppError::PathNotAccessible(format!("{item_id} is not a skill of the Context"))
    })
}

/// The agents enabled in Providers are the scan's input: sources outside the
/// target's repository boundary are read only for them. The client homes
/// come from the login shell environment the agents run in (Stage 10 `03`
/// A1), else from the app's.
async fn discover_and_publish(
    state: &AgentContextState,
    agents: &AgentSetupState,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    let login = LoginEnvironment::session().get().await;
    let environment =
        svode_core::agent_adapters::source_registry_environment(|name| match &login {
            Some(login) => login.get(name).map(OsStr::to_os_string),
            None => std::env::var_os(name),
        })?;
    let enabled_agents = agents.enabled_agents().await;
    let project_path = PathBuf::from(project_path);
    let space_path = PathBuf::from(space_path);
    let content = tokio::task::spawn_blocking(move || {
        scanner::scan(&project_path, &space_path, &environment, &enabled_agents)
    })
    .await
    .map_err(|error| AppError::General(format!("agent context scan task failed: {error}")))??;
    let key = format!("{}\0{}", content.project_root, content.target_root);
    state.publish(key, content)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use svode_core::agent_context::model::{
        AgentContextSnapshotContent, ContextItem, ContextItemKind, ContextLocation,
        ContextLocationKind, ContextSkillFacts, MarkdownPreview, SourceHealth,
    };

    fn published_skill(directory: &std::path::Path) -> AgentContextState {
        let item = ContextItem {
            id: "skill:review".to_string(),
            kind: ContextItemKind::Skill,
            name: "review".to_string(),
            description: None,
            path: directory.join("SKILL.md").to_string_lossy().into_owned(),
            owner_root: directory.to_string_lossy().into_owned(),
            location: ContextLocation {
                kind: ContextLocationKind::Absolute,
                path: String::new(),
            },
            modified_at: None,
            health: SourceHealth::Normal,
            health_reasons: Vec::new(),
            providers: Vec::new(),
            unapplied: None,
            idle_readers: Vec::new(),
            rejections: Vec::new(),
            sources: Vec::new(),
            preview: MarkdownPreview {
                markdown: String::new(),
                truncated: false,
                bytes_read: 0,
                total_bytes: 0,
            },
            references: Vec::new(),
            skill: Some(ContextSkillFacts {
                directory: directory.to_string_lossy().into_owned(),
                has_files: true,
                license: None,
                compatibility: None,
                metadata: None,
                allowed_tools: None,
            }),
            plugin: None,
            mcp: None,
            components: Vec::new(),
            icon: None,
            managed_by_svode: false,
        };
        let state = AgentContextState::new();
        state
            .publish(
                "key".to_string(),
                AgentContextSnapshotContent {
                    project_root: "/project".to_string(),
                    target_root: "/project".to_string(),
                    repository_root: "/project".to_string(),
                    enabled_agents: Vec::new(),
                    items: vec![item],
                    diagnostics: Vec::new(),
                    observed_project_paths: Vec::new(),
                    observed_personal_paths: Vec::new(),
                },
            )
            .unwrap();
        state
    }

    #[test]
    fn skill_documents_and_media_resolve_only_inside_a_published_skill_folder() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let skill = base.join("review");
        fs::create_dir_all(skill.join("assets")).unwrap();
        fs::write(skill.join("SKILL.md"), "body").unwrap();
        fs::write(skill.join("assets/guide.pdf"), b"%PDF").unwrap();
        fs::write(skill.join("assets/logo.png"), b"png").unwrap();
        fs::write(base.join("outside.pdf"), b"%PDF").unwrap();
        let state = published_skill(&skill);

        let guide = skill_file(
            &state,
            "skill:review",
            "assets/guide.pdf",
            SkillFileKind::Document,
        )
        .unwrap();
        assert_eq!(guide, skill.join("assets/guide.pdf"));
        assert!(inspect_local_document_source(&guide).is_ok());
        assert!(
            skill_file(
                &state,
                "skill:review",
                "assets/logo.png",
                SkillFileKind::Media
            )
            .is_some()
        );
        for path in [
            "../outside.pdf",
            "assets/../../outside.pdf",
            base.join("outside.pdf").to_str().unwrap(),
            "assets/logo.png",
        ] {
            assert!(
                skill_file(&state, "skill:review", path, SkillFileKind::Document).is_none(),
                "{path}"
            );
        }
        assert!(
            skill_file(
                &state,
                "skill:other",
                "assets/guide.pdf",
                SkillFileKind::Document
            )
            .is_none()
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("outside.pdf"), skill.join("assets/escape.pdf"))
                .unwrap();
            std::os::unix::fs::symlink(&base, skill.join("parent")).unwrap();
            for path in ["assets/escape.pdf", "parent/outside.pdf"] {
                assert!(
                    skill_file(&state, "skill:review", path, SkillFileKind::Document).is_none(),
                    "{path}"
                );
            }
        }
    }
}
