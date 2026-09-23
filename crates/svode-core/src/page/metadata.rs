use std::path::{Path, PathBuf};

use crate::page::PageError;
use crate::page::dates::GitDateExecutor;
use crate::page::entry;

use super::write::{PageRuntime, PageWrite, PageWriteOutcome};

pub struct PageMetadataPatch {
    pub title: Option<String>,
    pub icon: Option<Option<String>>,
    pub description: Option<Option<String>>,
    pub cover: Option<Option<entry::Cover>>,
}

impl PageMetadataPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.icon.is_none()
            && self.description.is_none()
            && self.cover.is_none()
    }
}

pub struct PageMetadataOutcome {
    pub page: entry::Entry,
    pub changed_paths: Vec<PathBuf>,
}

pub async fn patch<E, F, Fut, Err>(
    space: &str,
    path: &str,
    patch: PageMetadataPatch,
    project: Option<&str>,
    runtime: PageRuntime<'_, E>,
    authorize: F,
) -> Result<PageMetadataOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    let current = entry::read(space, path)?;
    if patch.is_empty() {
        return Ok(PageMetadataOutcome {
            page: current,
            changed_paths: Vec::new(),
        });
    }

    let candidate = patched_metadata(&current.meta, &patch)?;

    let explicit_title = patch.title.as_deref();
    let PageWriteOutcome {
        result,
        changed_paths,
    } = super::write::write(
        PageWrite {
            space,
            path,
            content: &current.body,
            title: explicit_title,
            icon: None,
            extra: None,
            metadata: Some(candidate),
            field_batch: None,
            skip_rename: explicit_title.is_none(),
            project,
            source_version: None,
        },
        runtime,
        authorize,
    )
    .await?;
    let current_path = result.new_path.as_deref().unwrap_or(path);
    let mut page = entry::read(space, current_path)?;
    page.warnings = result.warnings;
    Ok(PageMetadataOutcome {
        page,
        changed_paths,
    })
}

/// Tri-state patch over the current metadata, validated by the field rules.
fn patched_metadata(
    current: &entry::EntryMeta,
    patch: &PageMetadataPatch,
) -> Result<entry::EntryMeta, PageError> {
    let mut candidate = current.clone();
    if let Some(title) = patch.title.as_ref() {
        entry::apply_entry_field_update(
            &mut candidate,
            "title",
            serde_json::Value::String(title.clone()),
        )?;
    }
    if let Some(icon) = patch.icon.clone() {
        entry::apply_entry_field_update(
            &mut candidate,
            "icon",
            icon.map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        )?;
    }
    if let Some(description) = patch.description.clone() {
        entry::apply_entry_field_update(
            &mut candidate,
            "description",
            description
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        )?;
    }
    if let Some(cover) = patch.cover.clone() {
        entry::apply_entry_field_update(
            &mut candidate,
            "cover",
            cover
                .map(serde_json::to_value)
                .transpose()?
                .unwrap_or(serde_json::Value::Null),
        )?;
    }
    Ok(candidate)
}

pub fn relative_changed_paths(space: &str, paths: &[PathBuf]) -> Vec<String> {
    let root = Path::new(space);
    paths
        .iter()
        .map(|path| {
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::state::IndexRuntimeState;
    use crate::page::nonce::WriteNonceRegistry;
    use crate::page::test_support::runtime;
    use std::fs;

    #[tokio::test]
    async fn patch_uses_field_validation_and_managed_title_rename() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join("Old.md"),
            "---\ntitle: Old\ndescription: Before\n---\nBody",
        )
        .unwrap();
        let outcome = patch(
            root.to_str().unwrap(),
            "Old.md",
            PageMetadataPatch {
                title: Some("New".into()),
                icon: Some(Some("star".into())),
                description: Some(None),
                cover: None,
            },
            None,
            runtime(&IndexRuntimeState::default(), &WriteNonceRegistry::new()),
            |mut paths| async move {
                paths.push(root.to_path_buf());
                Ok::<_, PageError>(paths)
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.page.path, "New.md");
        assert_eq!(outcome.page.meta.icon.as_deref(), Some("star"));
        assert_eq!(outcome.page.meta.description, None);
        assert_eq!(outcome.page.body, "Body");
        assert!(!root.join("Old.md").exists());
    }

    #[tokio::test]
    async fn invalid_patch_does_not_apply_valid_title() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = "---\ntitle: Old\n---\nBody";
        fs::write(root.join("Old.md"), source).unwrap();
        let result = patch(
            root.to_str().unwrap(),
            "Old.md",
            PageMetadataPatch {
                title: Some("New".into()),
                icon: None,
                description: Some(Some("x".repeat(501))),
                cover: None,
            },
            None,
            runtime(&IndexRuntimeState::default(), &WriteNonceRegistry::new()),
            |mut paths| async move {
                paths.push(root.to_path_buf());
                Ok::<_, PageError>(paths)
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(root.join("Old.md")).unwrap(), source);
        assert!(!root.join("New.md").exists());
    }

    #[tokio::test]
    async fn nullable_metadata_clears_and_whitespace_is_not_trimmed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join("Page.md"),
            "---\ntitle: Page\nicon: star\ndescription: Before\ncover:\n  type: color\n  value: blue\n---\nBody",
        )
        .unwrap();
        let outcome = patch(
            root.to_str().unwrap(),
            "Page.md",
            PageMetadataPatch {
                title: None,
                icon: Some(None),
                description: Some(Some("  keep whitespace  ".into())),
                cover: Some(None),
            },
            None,
            runtime(&IndexRuntimeState::default(), &WriteNonceRegistry::new()),
            |mut paths| async move {
                paths.push(root.to_path_buf());
                Ok::<_, PageError>(paths)
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.page.meta.icon, None);
        assert_eq!(outcome.page.meta.cover, None);
        assert_eq!(
            outcome.page.meta.description.as_deref(),
            Some("  keep whitespace  ")
        );
    }
}
