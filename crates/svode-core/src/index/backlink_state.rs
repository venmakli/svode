use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use sqlx::SqlitePool;

use super::backlinks::{
    LinkSource, LinkSpan, collect_md_files, is_backlink_discoverable_path,
    is_external_or_anchor_url, markdown_url_path, parse_markdown_links,
};
use super::state::IndexRuntimeState;
use super::{IndexError, IndexKey};
use crate::content_tree::policy::TreeIgnorePolicy;
use crate::git::path::{RootMode, normalize_repo_relative, repo_relative_from_base};

impl IndexRuntimeState {
    async fn remove_source_from_project(&self, project: &Path, source: &LinkSource) {
        for key in self.keys_for_project(project).await {
            self.backlinks_for(&key).await.remove_source(source);
        }
    }

    async fn unready_target_space_id(
        &self,
        project: &Path,
        source_dir: &Path,
        source_space_id: Option<&str>,
        source_rel: &str,
        url: &str,
    ) -> Option<String> {
        if is_external_or_anchor_url(url) {
            return source_space_id.map(ToString::to_string);
        }
        let mut target = PathBuf::new();
        let parent = Path::new(source_rel).parent().unwrap_or(Path::new(""));
        for component in source_dir
            .join(parent)
            .join(markdown_url_path(url))
            .components()
        {
            match component {
                Component::Prefix(value) => target.push(value.as_os_str()),
                Component::RootDir => target.push(std::path::MAIN_SEPARATOR.to_string()),
                Component::CurDir => {}
                Component::Normal(value) => target.push(value),
                Component::ParentDir => {
                    if !target.pop() {
                        return None;
                    }
                }
            }
        }
        let first = target.strip_prefix(project).ok()?.components().next()?;
        let Component::Normal(folder) = first else {
            return None;
        };
        self.spaces_cache
            .lock()
            .await
            .get(project)?
            .by_folder
            .get(folder.to_str()?)
            .cloned()
    }

    pub async fn update_file_backlinks(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_rel_path: &str,
    ) -> Result<(), IndexError> {
        let source_key = self
            .key_for_project_space_id(project, source_space_id)
            .await?;
        let source_dir = self.dir_for_key(&source_key).await?;
        let source_rel = normalize_repo_relative(source_rel_path, RootMode::Reject)?;
        let source = LinkSource {
            source_space_id: Self::space_id_for_key(&source_key),
            source_path: source_rel.clone(),
        };
        self.remove_source_from_project(project, &source).await;
        let pool = self.get_or_create(&source_key).await?;
        sqlx::query("DELETE FROM broken_links WHERE source_rel_path = ?")
            .bind(&source_rel)
            .execute(&pool)
            .await?;

        let abs = source_dir.join(&source_rel);
        if !abs.exists() {
            return Ok(());
        }
        let policy = TreeIgnorePolicy::from_space_root(&source_dir);
        if !is_backlink_discoverable_path(&source_dir, &source_rel, &policy) {
            return Ok(());
        }
        let content = std::fs::read_to_string(&abs)?;
        let mut grouped: HashMap<IndexKey, HashMap<String, Vec<LinkSpan>>> = HashMap::new();
        for (url, span) in parse_markdown_links(&content) {
            let Some((target_key, target_rel)) = self
                .resolve_link_target_key(project, source_space_id, &source_rel, &url)
                .await?
            else {
                let target_space_id = self
                    .unready_target_space_id(
                        project,
                        &source_dir,
                        source_space_id,
                        &source_rel,
                        &url,
                    )
                    .await;
                insert_broken_link(&pool, &source_rel, target_space_id.as_deref(), &url).await?;
                continue;
            };
            let target_dir = self.dir_for_key(&target_key).await?;
            let target_abs = target_dir.join(&target_rel);
            let target_policy = TreeIgnorePolicy::from_space_root(&target_dir);
            if !is_backlink_discoverable_path(&target_dir, &target_rel, &target_policy) {
                continue;
            }
            if !target_abs.exists() {
                let target_space_id = Self::space_id_for_key(&target_key);
                insert_broken_link(&pool, &source_rel, target_space_id.as_deref(), &url).await?;
                continue;
            }
            grouped
                .entry(target_key)
                .or_default()
                .entry(target_rel)
                .or_default()
                .push(span);
        }
        for (target_key, by_target) in grouped {
            let index = self.backlinks_for(&target_key).await;
            for (target_rel, spans) in by_target {
                index.add_source_links(&target_rel, source.clone(), spans);
            }
        }
        Ok(())
    }

    pub async fn remove_file_backlinks(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_rel_path: &str,
    ) -> Result<(), IndexError> {
        let source_key = self
            .key_for_project_space_id(project, source_space_id)
            .await?;
        let source_rel = normalize_repo_relative(source_rel_path, RootMode::Reject)?;
        let source = LinkSource {
            source_space_id: Self::space_id_for_key(&source_key),
            source_path: source_rel.clone(),
        };
        self.remove_source_from_project(project, &source).await;
        let pool = self.get_or_create(&source_key).await?;
        sqlx::query("DELETE FROM broken_links WHERE source_rel_path = ?")
            .bind(&source_rel)
            .execute(&pool)
            .await?;
        Ok(())
    }

    pub async fn rebuild_source_backlinks(&self, key: &IndexKey) -> Result<(), IndexError> {
        let dir = self.dir_for_key(key).await?;
        let skip = self.skip_folders_for(key).await;
        let files = collect_md_files(&dir, &skip)?;
        let source_space_id = Self::space_id_for_key(key);
        for target_key in self.keys_for_project(key.project()).await {
            self.backlinks_for(&target_key)
                .await
                .remove_sources_in_space(source_space_id.as_deref());
        }
        let pool = self.get_or_create(key).await?;
        sqlx::query("DELETE FROM broken_links")
            .execute(&pool)
            .await?;
        for file in files {
            let rel = repo_relative_from_base(&dir, &file, RootMode::Reject)?;
            self.update_file_backlinks(key.project(), source_space_id.as_deref(), &rel)
                .await?;
        }
        Ok(())
    }

    pub async fn ensure_project_backlinks_built(&self, project: &Path) -> Result<(), IndexError> {
        let keys = self.keys_for_project(project).await;
        if self.backlinks_built_for(&keys).await {
            return Ok(());
        }
        self.invalidate_backlinks_for(&keys).await;
        for key in &keys {
            self.rebuild_source_backlinks(key).await?;
        }
        for key in &keys {
            self.backlinks_for(key).await.mark_built();
        }
        Ok(())
    }
}

async fn insert_broken_link(
    pool: &SqlitePool,
    source_rel: &str,
    target_space_id: Option<&str>,
    target_url: &str,
) -> Result<(), IndexError> {
    sqlx::query(
        "INSERT OR REPLACE INTO broken_links \
         (source_rel_path, target_space_id, target_url, detected_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(source_rel)
    .bind(target_space_id)
    .bind(target_url)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}
