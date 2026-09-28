use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::children::DirectoryKind;
use super::policy::TreeIgnorePolicy;
use super::{ContentTreeError, directory_facts, is_readme_name, normalize_parent_path};

/// Scope owner identity of one content target, by the same direct-marker rule
/// the content tree uses for its nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScopeOwnerIdentity {
    PageFile,
    PageDirectory,
    CollectionDirectory,
    AppDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeOwnerFacts {
    pub identity: ScopeOwnerIdentity,
    /// The Page file for a leaf Page, otherwise the owner directory.
    pub owner_path: String,
    /// The existing README (any case) of a directory owner, or `README.md`
    /// in it when the owner has none; the Page file for a leaf Page.
    pub content_path: String,
    pub has_app: bool,
}

/// Resolve a Page file, a directory README path or a directory to the scope
/// owner it opens. The Space root directory belongs to the registered Space
/// owner and a directory without README, schema.yaml or app.yaml is not an
/// owner.
pub fn scope_owner_facts(space: &Path, path: &str) -> Result<ScopeOwnerFacts, ContentTreeError> {
    let rel = normalize_parent_path(path)?;
    let abs = space.join(&rel);
    let readme_target = Path::new(&rel)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_readme_name);
    let metadata = match fs::symlink_metadata(&abs) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let owner_rel = match &metadata {
        Some(metadata) if metadata.is_dir() => rel.clone(),
        Some(metadata) if metadata.is_file() && !readme_target => {
            if !rel.to_lowercase().ends_with(".md") {
                return Err(ContentTreeError::Invalid(format!(
                    "{rel} is not a Page or a scope owner directory"
                )));
            }
            return Ok(ScopeOwnerFacts {
                identity: ScopeOwnerIdentity::PageFile,
                owner_path: rel.clone(),
                content_path: rel,
                has_app: false,
            });
        }
        Some(metadata) if metadata.is_file() => parent_rel(&rel),
        // A missing README still names its directory owner.
        None if readme_target => parent_rel(&rel),
        _ => return Err(ContentTreeError::FileNotFound(rel)),
    };
    if owner_rel == "." {
        if !readme_target {
            return Err(ContentTreeError::Invalid(
                "the Space root is a registered Space owner".to_string(),
            ));
        }
        // The root README opened as content is a Page of its own; the
        // registered Space owner keeps the directory capabilities.
        return Ok(ScopeOwnerFacts {
            identity: ScopeOwnerIdentity::PageFile,
            owner_path: rel.clone(),
            content_path: rel,
            has_app: false,
        });
    }
    let owner_abs = space.join(&owner_rel);
    if !owner_abs.is_dir() {
        return Err(ContentTreeError::FileNotFound(rel));
    }
    let policy = TreeIgnorePolicy::from_space_root(space);
    let (facts, readme) = directory_facts(space, &owner_abs, &policy)?;
    let identity = match facts.kind() {
        DirectoryKind::Collection => ScopeOwnerIdentity::CollectionDirectory,
        DirectoryKind::Page => ScopeOwnerIdentity::PageDirectory,
        DirectoryKind::App => ScopeOwnerIdentity::AppDirectory,
        DirectoryKind::Directory => {
            return Err(ContentTreeError::Invalid(format!(
                "{owner_rel} is not a scope owner directory"
            )));
        }
    };
    let content_path = readme
        .and_then(|readme| {
            readme
                .file_name()
                .map(|name| format!("{owner_rel}/{}", name.to_string_lossy()))
        })
        .unwrap_or_else(|| format!("{owner_rel}/README.md"));
    Ok(ScopeOwnerFacts {
        identity,
        owner_path: owner_rel,
        content_path,
        has_app: facts.has_app,
    })
}

fn parent_rel(rel: &str) -> String {
    rel.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_else(|| ".".to_string())
}
