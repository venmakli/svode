//! Qwen Code keys its chat store by the spelling of `cwd`.

use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::path::{Component, Prefix};

#[cfg(windows)]
pub(crate) fn ordinary_cwd(canonical: &Path) -> Option<PathBuf> {
    if !matches!(
        canonical.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..))
    ) || canonical.components().any(|component| match component {
        Component::Normal(name) => name.to_str().is_none_or(|name| name.ends_with(['.', ' '])),
        Component::CurDir | Component::ParentDir => true,
        _ => false,
    }) {
        return None;
    }
    let ordinary = PathBuf::from(svode_core::system_path::user_facing_path_str(
        canonical.to_str()?,
    ));
    // Dropping a verbatim prefix can change which folder Windows opens.
    (std::fs::canonicalize(&ordinary).ok().as_deref() == Some(canonical)).then_some(ordinary)
}

#[cfg(not(windows))]
pub(crate) fn ordinary_cwd(_canonical: &Path) -> Option<PathBuf> {
    None
}

pub(crate) fn existing_cwd(checked: &Path, listed: Option<&Path>) -> PathBuf {
    if let Some(listed) = listed
        && (listed == checked
            || (cfg!(windows)
                && differs_only_by_case(listed, checked)
                && listed.canonicalize().ok().as_deref() == Some(checked)))
    {
        return checked.to_path_buf();
    }
    let ordinary = ordinary_cwd(checked);
    ordinary.unwrap_or_else(|| checked.to_path_buf())
}

fn differs_only_by_case(left: &Path, right: &Path) -> bool {
    match (left.to_str(), right.to_str()) {
        (Some(left), Some(right)) => left.to_lowercase() == right.to_lowercase(),
        _ => false,
    }
}

/// Qwen's Windows store folds case, and can report worktrees nested in a
/// folder. The host checks these candidates against the real folder.
pub(crate) fn report_may_belong_to_folder(
    cwd: &Path,
    canonical: &Path,
    ordinary: Option<&Path>,
) -> bool {
    [Some(canonical), ordinary]
        .into_iter()
        .flatten()
        .any(|folder| cwd.starts_with(folder) || differs_only_by_case(cwd, folder))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn qwen_windows_catalog_keeps_paths_that_require_verbatim_semantics() {
        for raw in [
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\Project",
            r"\\?\C:\Project.\Nested",
            r"\\?\UNC\server\share\Nested ",
        ] {
            let checked = Path::new(raw);
            assert!(ordinary_cwd(checked).is_none());
            assert_eq!(existing_cwd(checked, None), checked);
        }
    }
}
