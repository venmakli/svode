use super::*;
use crate::index::IndexError;
use crate::index::backlinks::BacklinkIndex;
use crate::index::state::IndexRuntimeState;
use crate::index::update::{self, IndexUpdateState};
use crate::page::dates::GitDateExecutor;
use crate::page::nonce::WriteNonceRegistry;

/// Shared runtime state a Page mutation publishes into: the Project index,
/// Routine observation, watcher echo nonces and the Git date provider.
pub struct PageRuntime<'a, E> {
    pub index: &'a IndexRuntimeState,
    pub updates: &'a IndexUpdateState,
    pub nonces: &'a WriteNonceRegistry,
    pub git_dates: Option<&'a E>,
}

impl<E> Clone for PageRuntime<'_, E> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<E> Copy for PageRuntime<'_, E> {}

async fn space_path_of(
    state: &IndexRuntimeState,
    project: &Path,
    space_id: Option<&str>,
) -> Result<PathBuf, IndexError> {
    let key = state.key_for_project_space_id(project, space_id).await?;
    state.dir_for_key(&key).await
}

/// Validate, plan, authorize and apply one Page write, then publish its
/// derived projection. Authorization receives the full planned touched-set;
/// a projection failure after the source write is an applied warning.
pub async fn write<E, F, Fut, Err>(
    request: PageWrite<'_>,
    runtime: PageRuntime<'_, E>,
    authorize: F,
) -> Result<PageWriteOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    let state = runtime.index;
    let nonces = runtime.nonces;
    let backlink_index = state
        .backlinks_for_space_dir(Path::new(request.space))
        .await;
    let plan = prepare(&request, state, &backlink_index).await?;
    let authorized = authorize(plan.paths.clone()).await?;
    let space = request.space.to_string();
    let path = request.path.to_string();
    let project = request.project.map(str::to_string);
    let mut outcome = crate::git::access::scope_authorized_mutation_paths(
        authorized,
        async {
            nonces
                .with_source_publication(|| {
                    let outcome = apply_sources(request, plan)?;
                    for path in &outcome.changed_paths {
                        nonces.register(
                            path.canonicalize().unwrap_or_else(|_| path.clone()),
                            outcome.result.write_nonce.clone(),
                        );
                    }
                    Ok(outcome)
                })
                .map_err(Err::from)
        },
        |error| Err::from(PageError::from(error)),
    )
    .await?;
    if outcome.changed_paths.is_empty() {
        return Ok(outcome);
    }

    let current = outcome.result.new_path.as_deref().unwrap_or(&path);
    if let Some(project) = project.as_deref() {
        for changed in &outcome.changed_paths {
            if !changed.is_file()
                || changed == &Path::new(&space).join(current)
                || changed
                    .extension()
                    .is_none_or(|extension| extension != "md")
            {
                continue;
            }
            if let Ok((key, relative)) = state.resolve(Path::new(project), changed).await {
                let source = ModifiedLinkSource {
                    space_id: IndexRuntimeState::space_id_for_key(&key),
                    path: relative,
                };
                if !outcome.result.modified_sources.contains(&source) {
                    outcome.result.modified_sources.push(source);
                }
            }
        }
        outcome.result.modified_files = outcome
            .result
            .modified_sources
            .iter()
            .map(|source| source.path.clone())
            .collect();
    }
    let projection = publish(
        runtime,
        &backlink_index,
        &space,
        project.as_deref(),
        &outcome.changed_paths,
        &path,
        current,
    )
    .await;
    if let Err(error) = projection {
        outcome.result.warnings.push(EntryWarning {
            kind: "projection_update_failed".into(),
            message: format!("Page was saved, but derived projection needs refresh: {error}"),
            path: Some(current.to_string()),
        });
    }
    Ok(outcome)
}

async fn prepare(
    request: &PageWrite<'_>,
    state: &IndexRuntimeState,
    backlinks: &BacklinkIndex,
) -> Result<WritePlan, PageError> {
    let mut rename = entry::planned_write_rename(
        request.space,
        request.path,
        requested_title(request),
        request.skip_rename,
    )?;
    let mut relation_paths = Vec::new();
    let mut warning = None;
    if let Some(planned) = &rename {
        let (old, new) = rename_roots(request, planned);
        let old = old.strip_prefix(request.space).unwrap().to_string_lossy();
        let new = new.strip_prefix(request.space).unwrap().to_string_lossy();
        match collections::relation_move_mutation_paths_with_project(
            request.space,
            request.project,
            &old,
            &new,
        ) {
            Ok(paths) => relation_paths = paths,
            Err(crate::collections::CollectionError::Schema(message)) => {
                warning = Some(EntryWarning::filename_rename_deferred(
                    request.path,
                    &format!("schema error: {message}"),
                ));
                rename = None;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut paths = vec![Path::new(request.space).join(request.path)];
    if let Some(batch) = request.field_batch.as_ref() {
        paths.extend_from_slice(batch.mutation_paths());
    }
    let mut links = Vec::new();
    let mut moved_sources = Vec::new();
    let mut link_targets = Vec::new();
    if let Some(planned) = &rename {
        let (old_root, new_root) = rename_roots(request, planned);
        paths.extend(
            relation_paths
                .iter()
                .map(|path| mapped_path(path, Some(&(new_root.clone(), old_root.clone())))),
        );
        paths.push(Path::new(request.space).join(".svode/order.json"));
        paths.extend(crate::storage::routes::managed_attachment_policy_paths(
            request.space,
            request.project,
        ));
        if let Some(folder) = &planned.folder_rename_old {
            let root = Path::new(request.space);
            moved_sources = crate::content_tree::collect_markdown_paths(
                root,
                &root.join(folder),
                &crate::content_tree::policy::TreeIgnorePolicy::from_space_root(root),
            )?;
            paths.extend(moved_sources.clone());
        }
        let mut targets = vec![request.path.to_string()];
        if let Some(folder) = &planned.folder_rename_old {
            targets.extend(backlinks.target_paths_under(folder));
        }
        let target_id = state.space_id_for_dir(Path::new(request.space)).await;
        if let Some(project) = request.project {
            state
                .ensure_project_backlinks_built(Path::new(project))
                .await?;
            if let Some(folder) = &planned.folder_rename_old {
                targets.extend(backlinks.target_paths_under(folder));
            }
        } else if !backlinks.is_built() {
            backlinks.build(Path::new(request.space))?;
            if let Some(folder) = &planned.folder_rename_old {
                targets.extend(backlinks.target_paths_under(folder));
            }
        }
        targets.sort();
        targets.dedup();
        link_targets = targets
            .iter()
            .map(|target| Path::new(request.space).join(target))
            .collect();
        for target in targets {
            for (source, _) in backlinks.sources_for_target(&target) {
                let dir = if let Some(project) = request.project {
                    space_path_of(state, Path::new(project), source.source_space_id.as_deref())
                        .await?
                } else {
                    PathBuf::from(request.space)
                };
                let absolute = dir.join(&source.source_path);
                if !absolute.is_file()
                    || links
                        .iter()
                        .any(|source: &LinkSource| source.absolute == absolute)
                {
                    continue;
                }
                paths.push(absolute.clone());
                links.push(LinkSource {
                    absolute,
                    identity: ModifiedLinkSource {
                        space_id: source.source_space_id,
                        path: source.source_path,
                    },
                });
            }
        }
        for absolute in &moved_sources {
            if !links.iter().any(|source| source.absolute == *absolute) {
                links.push(LinkSource {
                    absolute: absolute.clone(),
                    identity: ModifiedLinkSource {
                        space_id: target_id.clone(),
                        path: absolute
                            .strip_prefix(request.space)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    },
                });
            }
        }
    }
    paths.sort();
    paths.dedup();
    Ok(WritePlan {
        rename,
        links,
        moved_sources,
        link_targets,
        warning,
        paths,
    })
}

async fn publish<E: GitDateExecutor>(
    runtime: PageRuntime<'_, E>,
    backlinks: &BacklinkIndex,
    space: &str,
    project: Option<&str>,
    paths: &[PathBuf],
    original: &str,
    current: &str,
) -> Result<(), PageError> {
    checkpoint("projection")?;
    let (state, updates) = (runtime.index, runtime.updates);
    let mut errors = Vec::new();
    // All source writes are complete. Routine observation inside targeted updates
    // still precedes the corresponding index publication.
    let mut ordered = paths.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|path| path.exists());
    for path in ordered {
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        if let Some(project) = project {
            let project = Path::new(project);
            if let Err(error) =
                update::publish_managed_path(state, updates, runtime.git_dates, project, path).await
            {
                errors.push(error.to_string());
            }
        } else if let Ok(relative) = path.strip_prefix(space) {
            let relative = relative.to_string_lossy();
            if path.exists() {
                if let Err(error) = backlinks.update_file(Path::new(space), &relative) {
                    errors.push(error.to_string());
                }
            } else {
                backlinks.remove_file(&relative);
            }
        }
    }
    if project.is_some()
        && original != current
        && Path::new(original)
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("README.md"))
    {
        if let (Some(old), Some(new)) = (Path::new(original).parent(), Path::new(current).parent())
        {
            if let Err(error) = update::rebase_space_collection_schema_manifest(
                state,
                updates,
                Path::new(space),
                &old.to_string_lossy(),
                &new.to_string_lossy(),
            )
            .await
            {
                errors.push(error.to_string());
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(PageError::Index(errors.join("; ")))
    }
}
