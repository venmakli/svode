//! Link rewrites that a structural move performs across the Project.
//!
//! Planning returns the exact source files a rename/move would rewrite so the
//! caller can authorize the full touched-set before any byte is written.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::IndexError;
use super::backlinks::{
    ModifiedLinkSource, dedupe_modified_sources, link_stem, rebase_source_links_between,
    replace_link_urls_between,
};
use super::state::IndexRuntimeState;
use super::update::{self, IndexUpdateState};
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::git::path::{RootMode, normalize_repo_relative};
use crate::page::dates::GitDateExecutor;

/// The source files a planned link rewrite would touch.
#[derive(Debug, Clone, Default)]
pub struct ProjectLinkMutationPlan {
    mutation_paths: Vec<PathBuf>,
}

impl ProjectLinkMutationPlan {
    pub fn mutation_paths(&self) -> &[PathBuf] {
        &self.mutation_paths
    }
}

fn normalize_rel(path: &str) -> String {
    normalize_rel_result(path).unwrap_or_else(|_| path.replace('\\', "/"))
}

fn normalize_rel_result(path: &str) -> Result<String, IndexError> {
    Ok(normalize_repo_relative(path, RootMode::Reject)?)
}

impl IndexRuntimeState {
    /// Absolute directory of the Space owning `space_id` inside `project`.
    pub async fn space_path_of(
        &self,
        project: &Path,
        space_id: Option<&str>,
    ) -> Result<PathBuf, IndexError> {
        let key = self.key_for_project_space_id(project, space_id).await?;
        self.dir_for_key(&key).await
    }

    pub async fn plan_links_on_rename_project(
        &self,
        project: &Path,
        target_space_id: Option<&str>,
        old_path: &str,
    ) -> Result<ProjectLinkMutationPlan, IndexError> {
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_index = self.backlinks_for(&target_key).await;
        let mut mutation_paths = Vec::new();
        for (source, _) in target_index.sources_for_target(old_path) {
            let source_dir = self
                .space_path_of(project, source.source_space_id.as_deref())
                .await?;
            let source_abs = source_dir.join(source.source_path);
            if source_abs.is_file() {
                mutation_paths.push(source_abs);
            }
        }
        mutation_paths.sort();
        mutation_paths.dedup();
        Ok(ProjectLinkMutationPlan { mutation_paths })
    }

    pub async fn plan_links_on_folder_rename_project(
        &self,
        project: &Path,
        target_space_id: Option<&str>,
        old_folder: &str,
    ) -> Result<ProjectLinkMutationPlan, IndexError> {
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_index = self.backlinks_for(&target_key).await;
        let old_norm = normalize_rel_result(old_folder)?;
        let mut mutation_paths = Vec::new();
        for old_target in target_index.target_paths_under(&old_norm) {
            mutation_paths.extend(
                self.plan_links_on_rename_project(project, target_space_id, &old_target)
                    .await?
                    .mutation_paths,
            );
        }
        mutation_paths.sort();
        mutation_paths.dedup();
        Ok(ProjectLinkMutationPlan { mutation_paths })
    }

    pub async fn update_links_on_rename_project<E: GitDateExecutor>(
        &self,
        updates: &IndexUpdateState,
        git_dates: Option<&E>,
        project: &Path,
        target_space_id: Option<&str>,
        old_path: &str,
        new_path: &str,
        new_title: Option<&str>,
    ) -> Result<Vec<ModifiedLinkSource>, IndexError> {
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_dir = self.dir_for_key(&target_key).await?;
        let target_index = self.backlinks_for(&target_key).await;
        let sources = target_index.sources_for_target(old_path);
        if sources.is_empty() {
            return Ok(Vec::new());
        }

        let old_abs = target_dir.join(old_path);
        let new_abs = target_dir.join(new_path);
        let old_stem = link_stem(old_path);
        let text_replace = new_title.map(|title| (old_stem.as_str(), title));
        let mut planned = Vec::new();

        for (source, _) in sources {
            let source_dir = self
                .space_path_of(project, source.source_space_id.as_deref())
                .await?;
            let source_abs = source_dir.join(&source.source_path);
            if !source_abs.exists() {
                continue;
            }
            let content = std::fs::read_to_string(&source_abs)?;
            let updated =
                replace_link_urls_between(&content, &source_abs, &old_abs, &new_abs, text_replace);
            if updated != content {
                planned.push((
                    source_abs,
                    content,
                    updated,
                    ModifiedLinkSource {
                        space_id: source.source_space_id.clone(),
                        path: source.source_path.clone(),
                    },
                ));
            }
        }

        let mutation_paths = planned
            .iter()
            .map(|(path, _, _, _)| path.clone())
            .collect::<Vec<_>>();
        ensure_mutation_paths_were_authorized(&mutation_paths)?;
        let modified = write_planned_sources(planned)?;

        let modified = dedupe_modified_sources(modified);
        self.publish_modified_sources(
            updates,
            git_dates,
            project,
            &modified,
            "failed to update rewritten backlink source index",
        )
        .await?;
        Ok(modified)
    }

    pub async fn update_links_on_folder_rename_project<E: GitDateExecutor>(
        &self,
        updates: &IndexUpdateState,
        git_dates: Option<&E>,
        project: &Path,
        target_space_id: Option<&str>,
        old_folder: &str,
        new_folder: &str,
        new_head_title: Option<&str>,
    ) -> Result<Vec<ModifiedLinkSource>, IndexError> {
        let current_plan = self
            .plan_links_on_folder_rename_project(project, target_space_id, old_folder)
            .await?;
        ensure_mutation_paths_were_authorized(current_plan.mutation_paths())?;
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_dir = self.dir_for_key(&target_key).await?;
        let target_index = self.backlinks_for(&target_key).await;
        let old_norm = normalize_rel_result(old_folder)?;
        let new_norm = normalize_rel_result(new_folder)?;
        let old_prefix = format!("{old_norm}/");
        let mut targets = target_index
            .target_paths_under(&old_norm)
            .into_iter()
            .map(|old_target| {
                let remainder = old_target.strip_prefix(&old_prefix).unwrap_or(&old_target);
                let new_target = format!("{new_norm}/{remainder}");
                (old_target, new_target)
            })
            .collect::<Vec<_>>();
        targets.sort_by(|left, right| left.0.cmp(&right.0));
        let mut sources = targets
            .iter()
            .flat_map(|(old_target, _)| {
                target_index
                    .sources_for_target(old_target)
                    .into_iter()
                    .map(|(source, _)| source)
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        sources.sort_by(|left, right| {
            (&left.source_space_id, &left.source_path)
                .cmp(&(&right.source_space_id, &right.source_path))
        });
        let mut planned = Vec::new();
        for source in sources {
            let source_dir = self
                .space_path_of(project, source.source_space_id.as_deref())
                .await?;
            let source_abs = source_dir.join(&source.source_path);
            if !source_abs.exists() {
                continue;
            }
            let content = std::fs::read_to_string(&source_abs)?;
            let mut updated = content.clone();
            for (old_target, new_target) in &targets {
                let is_head = Path::new(old_target)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("readme.md"))
                    && Path::new(old_target).parent() == Some(Path::new(&old_norm));
                let text_replace = if is_head {
                    new_head_title.map(|title| (link_stem(old_target), title))
                } else {
                    None
                };
                updated = replace_link_urls_between(
                    &updated,
                    &source_abs,
                    &target_dir.join(old_target),
                    &target_dir.join(new_target),
                    text_replace
                        .as_ref()
                        .map(|(old_stem, title)| (old_stem.as_str(), *title)),
                );
            }
            if updated != content {
                planned.push((
                    source_abs,
                    content,
                    updated,
                    ModifiedLinkSource {
                        space_id: source.source_space_id,
                        path: source.source_path,
                    },
                ));
            }
        }
        let modified = write_planned_sources(planned)?;
        self.publish_modified_sources(
            updates,
            git_dates,
            project,
            &modified,
            "failed to update rewritten folder backlink source index",
        )
        .await?;
        Ok(modified)
    }

    /// Rewrite the relative links inside a source that has just moved, so they
    /// keep pointing at the same targets from the new location.
    pub async fn rebase_source_links_project(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        old_path: &str,
        new_path: &str,
    ) -> Result<Option<ModifiedLinkSource>, IndexError> {
        let source_dir = self.space_path_of(project, source_space_id).await?;
        let old_abs = source_dir.join(old_path);
        let new_abs = source_dir.join(new_path);
        if !new_abs.exists() {
            return Ok(None);
        }

        let content = std::fs::read_to_string(&new_abs)?;
        let updated = rebase_source_links_between(&content, &old_abs, &new_abs);
        if updated == content {
            return Ok(None);
        }

        std::fs::write(&new_abs, updated)?;
        self.update_file_backlinks(project, source_space_id, new_path)
            .await?;
        Ok(Some(ModifiedLinkSource {
            space_id: source_space_id.map(ToString::to_string),
            path: normalize_rel(new_path),
        }))
    }

    async fn publish_modified_sources<E: GitDateExecutor>(
        &self,
        updates: &IndexUpdateState,
        git_dates: Option<&E>,
        project: &Path,
        modified: &[ModifiedLinkSource],
        context: &str,
    ) -> Result<(), IndexError> {
        for item in modified {
            let source_dir = self
                .space_path_of(project, item.space_id.as_deref())
                .await?;
            if let Err(error) = update::publish_managed_path(
                self,
                updates,
                git_dates,
                project,
                &source_dir.join(&item.path),
            )
            .await
            {
                tracing::warn!("{context}: {error}");
            }
        }
        Ok(())
    }
}

type PlannedSource = (PathBuf, String, String, ModifiedLinkSource);

/// Write every planned source, restoring the already written ones when a later
/// write fails so a partial rewrite never survives.
fn write_planned_sources(
    planned: Vec<PlannedSource>,
) -> Result<Vec<ModifiedLinkSource>, IndexError> {
    let mut written = Vec::new();
    for (source_abs, content, updated, _) in &planned {
        if let Err(error) = std::fs::write(source_abs, updated) {
            for (written_path, original) in written {
                let _ = std::fs::write(written_path, original);
            }
            return Err(IndexError::Io(error));
        }
        written.push((source_abs, content));
    }
    Ok(planned
        .into_iter()
        .map(|(_, _, _, source)| source)
        .collect())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::IndexRuntimeState;
    use crate::index::IndexKey;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::page::test_support::update_state;

    #[tokio::test]
    async fn rebase_source_links_project_rewrites_content_and_backlink_source() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join("A.md"), "See [B](B.md).\n").unwrap();
        fs::write(project.join("B.md"), "Target.\n").unwrap();

        let state = IndexRuntimeState::default();
        state
            .update_file_backlinks(project, None, "A.md")
            .await
            .unwrap();
        let root_key = IndexKey::Root(project.to_path_buf());
        let target_index = state.backlinks_for(&root_key).await;
        assert_eq!(target_index.get_backlinks("B.md")[0].source_path, "A.md");

        fs::create_dir_all(project.join("Folder")).unwrap();
        fs::rename(project.join("A.md"), project.join("Folder").join("A.md")).unwrap();
        state
            .remove_file_backlinks(project, None, "A.md")
            .await
            .unwrap();

        let modified = state
            .rebase_source_links_project(project, None, "A.md", "Folder/A.md")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(modified.path, "Folder/A.md");
        assert_eq!(
            fs::read_to_string(project.join("Folder").join("A.md")).unwrap(),
            "See [B](../B.md).\n"
        );
        let backlinks = target_index.get_backlinks("B.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "Folder/A.md");
    }

    #[tokio::test]
    async fn folder_rename_project_rewrites_descendant_target_links() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("Docs")).unwrap();
        fs::create_dir_all(project.join("Folder").join("Sub")).unwrap();
        fs::write(
            project.join("Docs").join("Source.md"),
            "See [Target](../Folder/Sub/Target.md).\n",
        )
        .unwrap();
        fs::write(
            project.join("Folder").join("Sub").join("Target.md"),
            "Target.\n",
        )
        .unwrap();

        let state = IndexRuntimeState::default();
        let root_key = IndexKey::Root(project.to_path_buf());
        state
            .update_file_backlinks(project, None, "Docs/Source.md")
            .await
            .unwrap();
        state.backlinks_for(&root_key).await.mark_built();

        fs::rename(project.join("Folder"), project.join("Archive")).unwrap();
        let modified = state
            .update_links_on_folder_rename_project(
                update_state(),
                None::<&SystemGitDateExecutor>,
                project,
                None,
                "Folder",
                "Archive",
                None,
            )
            .await
            .unwrap();

        assert_eq!(modified.len(), 1);
        assert_eq!(modified[0].path, "Docs/Source.md");
        assert_eq!(
            fs::read_to_string(project.join("Docs").join("Source.md")).unwrap(),
            "See [Target](../Archive/Sub/Target.md).\n"
        );
        let target_index = state.backlinks_for(&root_key).await;
        assert!(
            target_index
                .get_backlinks("Folder/Sub/Target.md")
                .is_empty()
        );
        let backlinks = target_index.get_backlinks("Archive/Sub/Target.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "Docs/Source.md");
    }
}
