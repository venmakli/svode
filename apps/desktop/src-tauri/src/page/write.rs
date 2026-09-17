use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::files::backlinks::{
    link_stem, rebase_source_links_between_moved_tree, replace_link_urls_between,
};
use crate::files::entry::EntryWarning;
use crate::files::{ModifiedLinkSource, WriteResult, entry};

mod runtime;
pub(crate) use runtime::write;

pub(crate) struct PageWrite<'a> {
    pub space: &'a str,
    pub path: &'a str,
    pub content: &'a str,
    pub title: Option<&'a str>,
    pub icon: Option<&'a str>,
    pub extra: Option<HashMap<String, serde_yml::Value>>,
    pub skip_rename: bool,
    pub project: Option<&'a str>,
}

pub(crate) struct PageWriteOutcome {
    pub result: WriteResult,
    pub changed_paths: Vec<PathBuf>,
}

struct LinkSource {
    absolute: PathBuf,
    identity: ModifiedLinkSource,
}

struct WritePlan {
    rename: Option<entry::PlannedWriteRename>,
    relation_paths: Vec<PathBuf>,
    links: Vec<LinkSource>,
    moved_sources: Vec<PathBuf>,
    link_targets: Vec<PathBuf>,
    warning: Option<EntryWarning>,
    paths: Vec<PathBuf>,
}

fn rename_roots(request: &PageWrite<'_>, rename: &entry::PlannedWriteRename) -> (PathBuf, PathBuf) {
    let root = Path::new(request.space);
    if let Some(old) = &rename.folder_rename_old {
        (
            root.join(old),
            root.join(&rename.new_path).parent().unwrap().to_path_buf(),
        )
    } else {
        (root.join(request.path), root.join(&rename.new_path))
    }
}

fn mapped_path(path: &Path, roots: Option<&(PathBuf, PathBuf)>) -> PathBuf {
    match roots {
        Some((old, new)) if path == old => new.clone(),
        Some((old, new)) => path
            .strip_prefix(old)
            .map(|suffix| new.join(suffix))
            .unwrap_or_else(|_| path.to_path_buf()),
        None => path.to_path_buf(),
    }
}

struct SourceSnapshot {
    files: BTreeMap<PathBuf, Option<Vec<u8>>>,
    roots: Option<(PathBuf, PathBuf)>,
}

impl SourceSnapshot {
    fn capture(paths: &[PathBuf], roots: Option<(PathBuf, PathBuf)>) -> Result<Self, AppError> {
        let mut files = BTreeMap::new();
        for path in paths {
            let bytes = match fs::read(path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            files.insert(path.clone(), bytes);
        }
        Ok(Self { files, roots })
    }

    fn rollback(&self, cause: AppError) -> AppError {
        let mut failed = Vec::new();
        if let Some((old, new)) = &self.roots {
            if !old.exists() && new.exists() && fs::rename(new, old).is_err() {
                failed.extend([old.display().to_string(), new.display().to_string()]);
            }
            if new.exists() {
                failed.push(new.display().to_string());
            }
        }
        for (path, original) in &self.files {
            let restored = match original {
                Some(bytes) if fs::read(path).ok().as_ref() == Some(bytes) => Ok(()),
                Some(bytes) => fs::write(path, bytes),
                None => match fs::remove_file(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    result => result,
                },
            };
            if restored.is_err() {
                failed.push(path.display().to_string());
            }
        }
        if failed.is_empty() {
            cause
        } else {
            failed.sort();
            failed.dedup();
            AppError::PageWriteRecovery {
                cause: cause.to_string(),
                paths: failed,
            }
        }
    }

    fn changes(&self) -> Result<Vec<PathBuf>, AppError> {
        let mut changed = Vec::new();
        for (old, bytes) in &self.files {
            let current = mapped_path(old, self.roots.as_ref());
            let now = match fs::read(&current) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if &now != bytes || &current != old {
                changed.push(old.clone());
                if &current != old {
                    changed.push(current);
                }
            }
        }
        if let Some((old, new)) = &self.roots {
            changed.extend([old.clone(), new.clone()]);
        }
        changed.sort();
        changed.dedup();
        Ok(changed)
    }
}

fn apply_sources(request: PageWrite<'_>, plan: WritePlan) -> Result<PageWriteOutcome, AppError> {
    crate::files::naming::with_document_name_lock(request.space, || {
        let current = entry::planned_write_rename(
            request.space,
            request.path,
            request.title,
            request.skip_rename,
        )?;
        if current != plan.rename && plan.warning.is_none() {
            return Err(AppError::General(
                "Page rename plan changed; retry the operation".into(),
            ));
        }
        if plan.warning.is_some() {
            let title = match request.title {
                Some(title) => title.to_string(),
                None => entry::read(request.space, request.path)?.meta.title,
            };
            crate::files::naming::ensure_document_name_available(
                Path::new(request.space),
                request.path,
                &title,
            )?;
        }
        let roots = plan
            .rename
            .as_ref()
            .map(|rename| rename_roots(&request, rename));
        if let Some((old, new)) = &roots {
            let mut current_paths = crate::properties::relation_move_mutation_paths_with_project(
                request.space,
                request.project,
                &old.strip_prefix(request.space).unwrap().to_string_lossy(),
                &new.strip_prefix(request.space).unwrap().to_string_lossy(),
            )?;
            let mut planned_paths = plan.relation_paths.clone();
            current_paths.sort();
            planned_paths.sort();
            if current_paths != planned_paths {
                return Err(AppError::General(
                    "Page related source plan changed; retry the operation".into(),
                ));
            }
        }
        let snapshot = SourceSnapshot::capture(&plan.paths, roots.clone())?;
        let had_naming_intent =
            crate::files::filename::has_managed_naming_intent(request.space, request.path);
        let operation = (|| {
            let mut result = entry::write_under_name_lock(
                request.space,
                request.path,
                request.content,
                request.title,
                request.icon,
                request.extra,
                None,
                None,
                request.skip_rename || plan.warning.is_some(),
                request.project,
                Some(&plan.relation_paths),
            )?;
            if let Some(warning) = plan.warning {
                result.warnings.push(warning);
            }
            if let Some(rename) = plan.rename.as_ref().filter(|_| result.new_path.is_some()) {
                checkpoint("rename")?;
                let (old_root, new_root) = roots.as_ref().unwrap();
                for source in &plan.links {
                    let path = mapped_path(&source.absolute, roots.as_ref());
                    let content = fs::read_to_string(&path)?;
                    let mut updated = content.clone();
                    let mut targets = plan.link_targets.clone();
                    targets.sort();
                    targets.dedup();
                    for old in targets {
                        let new = mapped_path(&old, roots.as_ref());
                        let head = old == Path::new(request.space).join(request.path);
                        let stem = link_stem(request.path);
                        // References in moved sources are rebased below using their old location.
                        updated = replace_link_urls_between(
                            &updated,
                            &source.absolute,
                            &old,
                            &new,
                            if head {
                                request.title.map(|title| (stem.as_str(), title))
                            } else {
                                None
                            },
                        );
                    }
                    if updated != content {
                        fs::write(&path, updated)?;
                    }
                }
                checkpoint("links")?;
                if rename.folder_rename_old.is_some() {
                    for old in &plan.moved_sources {
                        let new = mapped_path(old, roots.as_ref());
                        let content = fs::read_to_string(&new)?;
                        let updated = rebase_source_links_between_moved_tree(
                            &content, old, &new, old_root, new_root,
                        );
                        if updated != content {
                            fs::write(new, updated)?;
                        }
                    }
                }
                checkpoint("relations")?;
                crate::commands::files::rebase_managed_attachment_routes(
                    request.space,
                    request.project,
                    &old_root
                        .strip_prefix(request.space)
                        .unwrap()
                        .to_string_lossy(),
                    &new_root
                        .strip_prefix(request.space)
                        .unwrap()
                        .to_string_lossy(),
                    rename.folder_rename_old.is_some(),
                )?;
                checkpoint("routing")?;
            }
            checkpoint("order")?;
            let changed_paths = snapshot.changes()?;
            result.modified_sources = plan
                .links
                .iter()
                .filter_map(|source| {
                    let absolute = mapped_path(&source.absolute, roots.as_ref());
                    if !changed_paths.contains(&absolute) {
                        return None;
                    }
                    let mut identity = source.identity.clone();
                    if source.absolute.starts_with(request.space) {
                        identity.path = absolute
                            .strip_prefix(request.space)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                    }
                    Some(identity)
                })
                .collect();
            result.modified_files = result
                .modified_sources
                .iter()
                .map(|source| source.path.clone())
                .collect();
            Ok(PageWriteOutcome {
                result,
                changed_paths,
            })
        })();
        operation.map_err(|error| {
            if had_naming_intent {
                crate::files::filename::mark_managed_naming_intent(request.space, request.path);
            }
            snapshot.rollback(error)
        })
    })
}

#[cfg(not(test))]
fn checkpoint(_: &str) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
thread_local! { static FAILURE: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) }; }

#[cfg(test)]
pub(crate) fn checkpoint(stage: &str) -> Result<(), AppError> {
    if FAILURE.with(|failure| *failure.borrow() == Some(stage)) {
        Err(AppError::General(format!("injected {stage} failure")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
