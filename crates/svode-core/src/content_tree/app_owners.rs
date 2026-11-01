use std::fs;
use std::path::{Path, PathBuf};

use super::policy::{TreeIgnorePolicy, TreePathKind};
use super::{ContentTreeError, child_folder_names, directory_facts, find_readme, repo_path_string};

/// One App owner of a Space as the content tree shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppOwnerSource {
    /// Owner directory relative to the Space; `.` for the Space root.
    pub owner_path: String,
    pub owner_dir: PathBuf,
    /// README of the owner (any case) relative to the Space.
    pub readme_path: Option<String>,
}

/// App owners of a Space: directories with a visible direct `app.yaml`,
/// the Space root included, found with the visibility and traversal of the
/// Space tree. Hidden markers give no App, ordinary source directories
/// inside an app-capable owner are not walked and child Spaces are left out.
pub fn app_owner_sources(space: &Path) -> Result<Vec<AppOwnerSource>, ContentTreeError> {
    if !space.is_dir() {
        return Err(ContentTreeError::FileNotFound(space.display().to_string()));
    }
    let skip_dirs = child_folder_names(space);
    let policy = TreeIgnorePolicy::from_space_root(space);
    let (root, readme) = directory_facts(space, space, &policy)?;
    let mut owners = Vec::new();
    if root.has_app {
        owners.push(owner_source(space, space, readme));
    }
    collect(space, space, root.has_app, &skip_dirs, &policy, &mut owners)?;
    owners.sort_by(|left, right| left.owner_path.cmp(&right.owner_path));
    Ok(owners)
}

/// Visible README (any case) of an owner directory relative to the Space,
/// the file the owner's `Описание` tab shows.
pub fn owner_readme_path(space: &Path, owner: &Path) -> Result<Option<String>, ContentTreeError> {
    let policy = TreeIgnorePolicy::from_space_root(space);
    let readme = find_readme(space, owner, &policy)?;
    Ok(readme.map(|readme| relative(space, &readme)))
}

fn collect(
    base: &Path,
    dir: &Path,
    parent_has_app: bool,
    skip_dirs: &std::collections::HashSet<String>,
    policy: &TreeIgnorePolicy,
    owners: &mut Vec<AppOwnerSource>,
) -> Result<(), ContentTreeError> {
    for entry in fs::read_dir(dir)?.filter_map(Result::ok) {
        let abs_path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&abs_path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let rel_path = relative(base, &abs_path);
        if policy.is_ignored_rel(Path::new(&rel_path), TreePathKind::Directory)
            || skip_dirs.contains(&rel_path)
        {
            continue;
        }
        let (facts, readme) = directory_facts(base, &abs_path, policy)?;
        if !facts.is_child_of(parent_has_app) {
            continue;
        }
        if facts.has_app {
            owners.push(owner_source(base, &abs_path, readme));
        }
        collect(base, &abs_path, facts.has_app, skip_dirs, policy, owners)?;
    }
    Ok(())
}

fn owner_source(base: &Path, dir: &Path, readme: Option<PathBuf>) -> AppOwnerSource {
    let owner_path = if dir == base {
        ".".to_string()
    } else {
        relative(base, dir)
    };
    AppOwnerSource {
        owner_path,
        owner_dir: dir.to_path_buf(),
        readme_path: readme.map(|readme| relative(base, &readme)),
    }
}

fn relative(base: &Path, path: &Path) -> String {
    repo_path_string(path.strip_prefix(base).unwrap_or(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content_tree::{TreeNode, build_tree};

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn tree_app_owners(nodes: &[TreeNode], owners: &mut Vec<String>) {
        for node in nodes {
            if node.has_app {
                let path = node.path.strip_suffix("/README.md").unwrap_or(&node.path);
                let path = path.strip_suffix("/readme.md").unwrap_or(path);
                owners.push(path.to_string());
            }
            tree_app_owners(&node.children, owners);
        }
    }

    #[test]
    fn owners_follow_the_visibility_and_traversal_of_the_space_tree() {
        let temp = tempfile::tempdir().unwrap();
        let space = temp.path().canonicalize().unwrap();
        let app = "runtime:\n  type: url\n  url: https://example.com\n";
        write(
            &space.join(".svode/config.json"),
            r#"{"name":"Space","spaces":[{"id":"child","path":"child","repo":null}]}"#,
        );
        write(&space.join("app.yaml"), app);
        write(&space.join("README.md"), "# Space\n");
        write(&space.join("page/README.md"), "# Page\n");
        write(&space.join("page/app.yaml"), app);
        write(&space.join("tasks/schema.yaml"), "columns: []\n");
        write(&space.join("tasks/app.yaml"), app);
        // An app-capable root shows only marker directories, so the folder
        // holding the next App is a Page and a plain one is not walked.
        write(&space.join("tools/README.md"), "# Tools\n");
        write(&space.join("vendor/lib/app.yaml"), app);
        write(&space.join("tools/board/app.yaml"), app);
        write(&space.join("tools/board/readme.md"), "# Board\n");
        // An ordinary source directory inside an App is not walked.
        write(&space.join("tools/board/src/widgets/app.yaml"), app);
        // A nested App owner below an App is a child of it.
        write(&space.join("tools/board/panel/app.yaml"), app);
        write(&space.join("hidden/app.yaml"), app);
        write(
            &space.join(".gitignore"),
            "hidden/\nignored-marker/app.yaml\n",
        );
        write(&space.join("ignored-marker/app.yaml"), app);
        write(
            &space.join("child/.svode/config.json"),
            r#"{"name":"Child"}"#,
        );
        write(&space.join("child/app.yaml"), app);

        let owners = app_owner_sources(&space).unwrap();
        let paths = owners
            .iter()
            .map(|owner| owner.owner_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [".", "page", "tasks", "tools/board", "tools/board/panel"]
        );
        let readmes = owners
            .iter()
            .map(|owner| owner.readme_path.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(
            readmes,
            [
                Some("README.md"),
                Some("page/README.md"),
                None,
                Some("tools/board/readme.md"),
                None
            ]
        );

        let mut from_tree = Vec::new();
        tree_app_owners(
            &build_tree(space.to_str().unwrap()).unwrap(),
            &mut from_tree,
        );
        from_tree.sort();
        assert_eq!(&paths[1..], from_tree.as_slice());
        assert_eq!(
            owner_readme_path(&space, &space.join("tools/board")).unwrap(),
            Some("tools/board/readme.md".to_string())
        );
    }
}
