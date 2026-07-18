use std::fs;
use std::path::{Component, Path, PathBuf};

use super::sources::{CandidateCwdSource, PersistedAgentSessionCandidate};
use super::types::{
    AgentSessionScope, AgentSessionScopeConfidence, AgentSessionScopeKind, AgentSessionScopeStatus,
};
use crate::error::AppError;
use crate::space::project as space_project;
use crate::space::types::{SpaceInfo, SpaceStatus};

#[derive(Debug, Clone)]
pub(super) struct ScopeIndex {
    entries: Vec<ScopeEntry>,
}

#[derive(Debug, Clone)]
struct ScopeEntry {
    kind: AgentSessionScopeKind,
    status: AgentSessionScopeStatus,
    path: PathBuf,
    project_path: String,
    space_id: Option<String>,
    space_path: Option<String>,
}

impl ScopeIndex {
    pub(super) fn new(project: &Path, child_spaces: Vec<SpaceInfo>) -> Result<Self, AppError> {
        let project_path = project.to_string_lossy().into_owned();
        let mut entries = vec![ScopeEntry {
            kind: AgentSessionScopeKind::Project,
            status: AgentSessionScopeStatus::Ready,
            path: project.to_path_buf(),
            project_path: project_path.clone(),
            space_id: None,
            space_path: None,
        }];

        for space in child_spaces {
            let raw_path = PathBuf::from(&space.path);
            let Some(path) = normalize_existing_or_lexical(&raw_path) else {
                continue;
            };
            entries.push(ScopeEntry {
                kind: AgentSessionScopeKind::Space,
                status: scope_status(space.status),
                project_path: project_path.clone(),
                space_id: Some(space.id),
                space_path: Some(path.to_string_lossy().into_owned()),
                path,
            });
        }

        entries.sort_by(|a, b| {
            b.path
                .components()
                .count()
                .cmp(&a.path.components().count())
        });
        Ok(Self { entries })
    }

    fn resolve(&self, cwd: &Path, cwd_source: CandidateCwdSource) -> Option<AgentSessionScope> {
        let entry = self
            .entries
            .iter()
            .find(|entry| cwd == entry.path || cwd.starts_with(&entry.path))?;
        let confidence = match cwd_source {
            CandidateCwdSource::WorktreeOriginal => AgentSessionScopeConfidence::WorktreeOriginal,
            CandidateCwdSource::Cwd if cwd == entry.path => AgentSessionScopeConfidence::Exact,
            CandidateCwdSource::Cwd => AgentSessionScopeConfidence::CwdPrefix,
        };

        Some(AgentSessionScope {
            kind: entry.kind,
            status: entry.status,
            confidence,
            project_path: entry.project_path.clone(),
            space_id: entry.space_id.clone(),
            space_path: entry.space_path.clone(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
        })
    }
}

pub(super) fn load_child_spaces(project: &Path) -> Result<Vec<SpaceInfo>, AppError> {
    match space_project::list_spaces(project) {
        Ok(spaces) => Ok(spaces),
        Err(AppError::FileNotFound(_)) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

pub(super) fn resolve_scope(
    scope_index: &ScopeIndex,
    candidate: &PersistedAgentSessionCandidate,
    home: &Path,
) -> Option<AgentSessionScope> {
    let cwd_raw = candidate.cwd.as_ref()?;
    let expanded = expand_home(cwd_raw, home);
    let cwd = normalize_existing_or_lexical(&expanded)?;
    scope_index.resolve(&cwd, candidate.cwd_source)
}

pub(super) fn normalize_project_path(project_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(project_path);
    let normalized = fs::canonicalize(&path)
        .map_err(|_| AppError::PathNotAccessible(path.to_string_lossy().into_owned()))?;
    if !normalized.is_dir() {
        return Err(AppError::PathNotAccessible(
            normalized.to_string_lossy().into_owned(),
        ));
    }
    Ok(normalized)
}

fn scope_status(status: SpaceStatus) -> AgentSessionScopeStatus {
    match status {
        SpaceStatus::Ready => AgentSessionScopeStatus::Ready,
        SpaceStatus::Missing => AgentSessionScopeStatus::Missing,
        SpaceStatus::Broken => AgentSessionScopeStatus::Broken,
    }
}

fn expand_home(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

fn normalize_existing_or_lexical(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = fs::canonicalize(path) {
        return Some(canonical);
    }
    if let Some(normalized) = normalize_from_existing_ancestor(path) {
        return Some(normalized);
    }
    normalize_lexical(path)
}

fn normalize_from_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if let Ok(mut canonical) = fs::canonicalize(current) {
            for component in missing.iter().rev() {
                canonical.push(component);
            }
            return Some(canonical);
        }
        let name = current.file_name()?.to_os_string();
        missing.push(name);
        current = current.parent()?;
    }
}

fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out)
}
