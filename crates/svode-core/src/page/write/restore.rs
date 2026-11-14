//! Restore of a Page source at a path that no longer exists, such as the
//! path of an open Page whose file or folder disappeared outside this host.
//! The source is written as given: its name is not derived from its title,
//! and no Collection defaults or `unique_id` are applied.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::runtime::publish;
use super::{PageRuntime, PageWriteOutcome, SourceSnapshot, checkpoint};
use crate::content_tree::policy::{TreeIgnorePolicy, TreePathKind};
use crate::page::dates::GitDateExecutor;
use crate::page::filename::portable_component_key;
use crate::page::source::normalize_page_path;
use crate::page::store::{PageWarning, WriteResult};
use crate::page::{PageError, current_source_version, ensure_path_in_space};

pub struct PageRestore<'a> {
    pub space: &'a str,
    /// Relative Markdown path of the Page, exactly as it was.
    pub path: &'a str,
    /// Complete Markdown source, frontmatter included.
    pub content: &'a str,
    pub project: Option<&'a str>,
}

/// Write `content` as the Page at `path`, which must not exist, creating
/// the missing ordinary folders of the path. A path of a child Space, a
/// system or hidden path and a path whose file or folder name is taken
/// portably are refused, and authorization covers the path, before any
/// write. The index is updated and the write is marked for the watcher;
/// a failure removes what the restore created.
pub async fn restore<E, F, Fut, Err>(
    request: PageRestore<'_>,
    runtime: PageRuntime<'_, E>,
    authorize: F,
) -> Result<PageWriteOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    ensure_path_in_space(request.space, request.path).map_err(Err::from)?;
    let path = restorable_path(request.space, request.path).map_err(Err::from)?;
    missing_folders(Path::new(request.space), &path).map_err(Err::from)?;
    let target = Path::new(request.space).join(&path);
    let authorized = authorize(vec![target.clone()]).await?;
    let nonces = runtime.nonces;
    let mut outcome = crate::git::access::scope_authorized_mutation_paths(
        authorized,
        async {
            nonces
                .with_source_publication(|| {
                    let outcome = apply(request.space, &path, request.content)?;
                    nonces.register(
                        target.canonicalize().unwrap_or_else(|_| target.clone()),
                        outcome.result.write_nonce.clone(),
                    );
                    Ok(outcome)
                })
                .map_err(Err::from)
        },
        |error| Err::from(PageError::from(error)),
    )
    .await?;
    let backlinks = runtime
        .index
        .backlinks_for_space_dir(Path::new(request.space))
        .await;
    if let Err(error) = publish(
        runtime,
        &backlinks,
        request.space,
        request.project,
        &outcome.changed_paths,
        &path,
        &path,
    )
    .await
    {
        outcome.result.warnings.push(PageWarning {
            kind: "projection_update_failed".into(),
            message: format!("Page was restored, but derived projection needs refresh: {error}"),
            path: Some(path.clone()),
            ..PageWarning::default()
        });
    }
    Ok(outcome)
}

/// The normalized Markdown path of a restore: relative, inside the Space,
/// not system and without a hidden component.
fn restorable_path(space: &str, path: &str) -> Result<String, PageError> {
    let path = normalize_page_path(path)?;
    let root = Path::new(space);
    if !root.is_dir() {
        return Err(PageError::SpaceNotFound(space.to_string()));
    }
    if path.split('/').any(|component| component.starts_with('.'))
        || TreeIgnorePolicy::system_only(root)
            .is_system_ignored_rel(Path::new(&path), TreePathKind::File)
    {
        return Err(PageError::PathNotAccessible(path));
    }
    Ok(path)
}

/// Folders of `path` to create, outermost first. An existing component is
/// followed only when it is a folder with exactly this name; a file name or
/// a name that differs only by case or Unicode normalization takes the path
/// portably and refuses it with the existing entry, as does an existing
/// target. The existing part must stay inside the Space.
fn missing_folders(root: &Path, path: &str) -> Result<Vec<PathBuf>, PageError> {
    let components = path.split('/').collect::<Vec<_>>();
    let mut current = root.to_path_buf();
    let mut existing = String::new();
    let mut missing = Vec::new();
    for (index, name) in components.iter().enumerate() {
        let last = index + 1 == components.len();
        let child = current.join(name);
        if missing.is_empty() {
            match taken_name(&current, name)? {
                Some(taken) if !last && taken == *name && child.is_dir() => {
                    existing = join_relative(&existing, name);
                    current = child;
                    continue;
                }
                Some(taken) => {
                    return Err(PageError::FileAlreadyExists(join_relative(
                        &existing, &taken,
                    )));
                }
                None => {}
            }
        }
        if !last {
            missing.push(child.clone());
        }
        current = child;
    }
    let space = fs::canonicalize(root)?;
    let deepest = fs::canonicalize(root.join(&existing))?;
    if !deepest.starts_with(&space) {
        return Err(PageError::PathNotAccessible(path.to_string()));
    }
    Ok(missing)
}

/// The entry of `parent`, as the directory lists it, that takes `name`: the
/// exact name first, then one with the same portable key. A file system
/// that ignores case answers a lookup of any spelling, so only the listing
/// tells the spelling on disk.
fn taken_name(parent: &Path, name: &str) -> Result<Option<String>, PageError> {
    let key = portable_component_key(name);
    let mut portable = None;
    for entry in fs::read_dir(parent)? {
        let entry = entry?.file_name().to_string_lossy().into_owned();
        if entry == name {
            return Ok(Some(entry));
        }
        if portable.is_none() && portable_component_key(&entry) == key {
            portable = Some(entry);
        }
    }
    Ok(portable)
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Creates the missing folders and the new source under the name lock,
/// checking again that the path is free.
fn apply(space: &str, path: &str, content: &str) -> Result<PageWriteOutcome, PageError> {
    crate::page::naming::with_document_name_lock(space, || {
        let root = Path::new(space);
        let folders = missing_folders(root, path)?;
        let target = root.join(path);
        let mut snapshot = SourceSnapshot::capture(&[], None)?;
        let operation = (|| {
            for folder in &folders {
                fs::create_dir(folder)?;
                snapshot.track_created_dir(folder.clone());
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            snapshot.track_created(target.clone());
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            checkpoint("restore")?;
            Ok(())
        })();
        if let Err(error) = operation {
            return Err(snapshot.rollback(match error {
                PageError::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    PageError::FileAlreadyExists(path.to_string())
                }
                error => error,
            }));
        }
        let source_version = current_source_version(root, path)
            .ok()
            .map(|version| version.as_str().to_string());
        Ok(PageWriteOutcome {
            result: WriteResult {
                new_path: None,
                modified_files: Vec::new(),
                modified_sources: Vec::new(),
                write_nonce: ulid::Ulid::new().to_string().to_lowercase(),
                warnings: Vec::new(),
                source_version,
            },
            changed_paths: vec![target],
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexKey;
    use crate::index::state::IndexRuntimeState;
    use crate::page::nonce::WriteNonceRegistry;
    use crate::page::store;
    use crate::page::test_support::{runtime, scaffold_space};

    const SOURCE: &str = "---\ntitle: Kept title\nstatus: draft\n---\nRestored edit\n";

    fn space() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        scaffold_space(root, "Space");
        fs::create_dir_all(root.join(".git")).unwrap();
        temp
    }

    async fn run(
        root: &Path,
        path: &str,
        state: &IndexRuntimeState,
        nonces: &WriteNonceRegistry,
    ) -> Result<PageWriteOutcome, PageError> {
        let space = root.to_str().unwrap();
        restore(
            PageRestore {
                space,
                path,
                content: SOURCE,
                project: Some(space),
            },
            runtime(state, nonces),
            |mut paths| async move {
                paths.push(root.to_path_buf());
                Ok(paths)
            },
        )
        .await
    }

    /// Every entry under `root` with its bytes, `.git` and `.svode` aside.
    fn tree(root: &Path) -> Vec<(String, Option<Vec<u8>>)> {
        let mut entries = Vec::new();
        let mut dirs = vec![root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = path.strip_prefix(root).unwrap().display().to_string();
                if rel == ".git" || rel == ".svode" {
                    continue;
                }
                if path.is_dir() {
                    entries.push((rel, None));
                    dirs.push(path);
                } else {
                    entries.push((rel, Some(fs::read(&path).unwrap())));
                }
            }
        }
        entries.sort();
        entries
    }

    #[tokio::test]
    async fn writes_the_source_as_given_with_missing_folders_and_indexes_it() {
        let temp = space();
        let root = temp.path().canonicalize().unwrap();
        let state = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::new();

        let outcome = run(&root, "docs/sub/a.md", &state, &nonces).await.unwrap();

        assert_eq!(
            fs::read_to_string(root.join("docs/sub/a.md")).unwrap(),
            SOURCE
        );
        // Only the Page is restored: the folders are ordinary, without a README.
        assert!(!root.join("docs/README.md").exists());
        assert!(!root.join("docs/sub/README.md").exists());
        assert_eq!(outcome.changed_paths, vec![root.join("docs/sub/a.md")]);
        assert!(outcome.result.new_path.is_none());
        assert!(outcome.result.warnings.is_empty());
        let page = store::read(root.to_str().unwrap(), "docs/sub/a.md").unwrap();
        assert_eq!(page.meta.title, "Kept title");
        assert_eq!(
            outcome.result.source_version.as_deref(),
            page.source_version.as_ref().map(|version| version.as_str())
        );
        assert_eq!(
            nonces
                .take_metadata(&root.join("docs/sub/a.md"))
                .map(|metadata| metadata.nonce),
            Some(outcome.result.write_nonce.clone())
        );
        let pool = state
            .get_or_create(&IndexKey::Root(root.clone()))
            .await
            .unwrap();
        let indexed: Vec<(String, String)> =
            sqlx::query_as("SELECT file_path, title FROM pages WHERE file_path = ?")
                .bind("docs/sub/a.md")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            indexed,
            vec![("docs/sub/a.md".to_string(), "Kept title".to_string())]
        );
    }

    #[tokio::test]
    async fn an_existing_folder_of_the_path_is_reused() {
        let temp = space();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/other.md"), "Other\n").unwrap();
        let state = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::new();

        run(&root, "docs/a.md", &state, &nonces).await.unwrap();

        assert_eq!(fs::read_to_string(root.join("docs/a.md")).unwrap(), SOURCE);
        assert_eq!(
            fs::read_to_string(root.join("docs/other.md")).unwrap(),
            "Other\n"
        );
    }

    #[tokio::test]
    async fn a_taken_path_is_refused_with_the_taken_name_without_writing() {
        for (existing, path, taken) in [
            ("docs/a.md", "docs/a.md", "docs/a.md"),
            ("docs/A.md", "docs/a.md", "docs/A.md"),
            ("Docs/b.md", "docs/a.md", "Docs"),
            ("docs", "docs/a.md", "docs"),
            ("Caf\u{e9}.md", "Cafe\u{301}.md", "Caf\u{e9}.md"),
        ] {
            let temp = space();
            let root = temp.path().canonicalize().unwrap();
            let file = root.join(existing);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "Existing\n").unwrap();
            let before = tree(&root);
            let state = IndexRuntimeState::default();
            let nonces = WriteNonceRegistry::new();

            let error = run(&root, path, &state, &nonces)
                .await
                .err()
                .expect("refused");

            assert!(
                matches!(&error, PageError::FileAlreadyExists(name) if name == taken),
                "{existing} -> {path}: {error:?}"
            );
            assert_eq!(tree(&root), before, "{existing} -> {path}");
        }
    }

    #[tokio::test]
    async fn a_system_or_hidden_path_is_refused_without_writing() {
        for path in [
            ".svode/a.md",
            ".git/a.md",
            ".assets/a.md",
            "docs/.templates/a.md",
            ".hidden/a.md",
            "docs/.a.md",
            "AGENTS.md",
            "../outside.md",
            "/absolute.md",
            "docs/a.txt",
        ] {
            let temp = space();
            let root = temp.path().canonicalize().unwrap();
            let before = tree(&root);
            let state = IndexRuntimeState::default();
            let nonces = WriteNonceRegistry::new();

            let error = run(&root, path, &state, &nonces)
                .await
                .err()
                .expect("refused");

            assert!(
                matches!(&error, PageError::PathNotAccessible(_)),
                "{path}: {error:?}"
            );
            assert_eq!(tree(&root), before, "{path}");
            assert!(!root.join(".svode/a.md").exists(), "{path}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_link_out_of_the_space_is_refused() {
        let temp = space();
        let root = temp.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        let state = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::new();

        let error = run(&root, "linked/a.md", &state, &nonces)
            .await
            .err()
            .expect("refused");

        assert!(
            matches!(error, PageError::PathNotAccessible(_)),
            "{error:?}"
        );
        assert!(!outside.path().join("a.md").exists());
    }

    #[tokio::test]
    async fn a_refused_authorization_writes_nothing() {
        let temp = space();
        let root = temp.path().canonicalize().unwrap();
        let before = tree(&root);
        let state = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::new();
        let space = root.to_str().unwrap();
        let target = root.join("docs/a.md");

        let error = restore(
            PageRestore {
                space,
                path: "docs/a.md",
                content: SOURCE,
                project: Some(space),
            },
            runtime(&state, &nonces),
            |paths| async move {
                assert_eq!(paths, vec![target]);
                Err::<Vec<PathBuf>, _>(PageError::General("denied".into()))
            },
        )
        .await
        .err()
        .expect("refused");

        assert!(matches!(&error, PageError::General(message) if message == "denied"));
        assert_eq!(tree(&root), before);
    }

    #[tokio::test]
    async fn a_failure_after_the_write_removes_the_file_and_created_folders() {
        let temp = space();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        let before = tree(&root);
        let state = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::new();

        super::super::inject_failure(Some("restore"), None);
        let result = run(&root, "docs/sub/deeper/a.md", &state, &nonces).await;
        super::super::inject_failure(None, None);

        let error = result.err().expect("injected failure");
        assert!(
            error.to_string().contains("injected restore failure"),
            "{error}"
        );
        assert_eq!(tree(&root), before);
        assert!(root.join("docs").is_dir());
        assert!(
            nonces
                .take_metadata(&root.join("docs/sub/deeper/a.md"))
                .is_none()
        );
    }
}
