use super::*;
use crate::files::{BacklinkIndex, WriteNonceRegistry};
use crate::git::autocommit::AutocommitService;
use crate::index::{self, IndexState, update::IndexUpdateState};
use crate::space::structural::{
    backlinks_for_space, entry_rename_op, grouped_abs_paths_by_space,
    managed_attachment_policy_paths, maybe_autocommit_structural_paths, space_id_for_dir,
};

pub(crate) async fn write<F, Fut>(
    request: PageWrite<'_>,
    state: &IndexState,
    updates: &IndexUpdateState,
    nonces: &WriteNonceRegistry,
    autocommit: Option<&AutocommitService>,
    authorize: F,
) -> Result<PageWriteOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    let backlink_index = backlinks_for_space(state, request.space).await;
    let plan = prepare(&request, state, &backlink_index).await?;
    let authorized = authorize(plan.paths.clone()).await?;
    let space = request.space.to_string();
    let path = request.path.to_string();
    let project = request.project.map(str::to_string);
    let mut outcome = crate::git::access::scope_authorized_mutation_paths(authorized, async {
        nonces.with_source_publication(|| {
            let outcome = apply_sources(request, plan)?;
            for path in &outcome.changed_paths {
                nonces.register(
                    path.canonicalize().unwrap_or_else(|_| path.clone()),
                    outcome.result.write_nonce.clone(),
                );
            }
            Ok(outcome)
        })
    })
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
                    space_id: IndexState::space_id_for_key(&key),
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
        state,
        updates,
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
    if let (Some(service), Some(new_path)) = (autocommit, outcome.result.new_path.as_deref()) {
        let operation = entry_rename_op(&space, &path, new_path);
        for (owner, paths) in
            grouped_abs_paths_by_space(project.as_deref(), &space, &outcome.changed_paths)
        {
            maybe_autocommit_structural_paths(
                service,
                project.as_deref(),
                &owner.to_string_lossy(),
                operation.clone(),
                paths,
            );
        }
    }
    Ok(outcome)
}

async fn prepare(
    request: &PageWrite<'_>,
    state: &IndexState,
    backlinks: &BacklinkIndex,
) -> Result<WritePlan, AppError> {
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
        match crate::properties::relation_move_mutation_paths_with_project(
            request.space,
            request.project,
            &old,
            &new,
        ) {
            Ok(paths) => relation_paths = paths,
            Err(AppError::General(message)) if message.starts_with("schema error:") => {
                warning = Some(EntryWarning::filename_rename_deferred(
                    request.path,
                    &message,
                ));
                rename = None;
            }
            Err(error) => return Err(error),
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
        paths.extend(managed_attachment_policy_paths(
            request.space,
            request.project,
        ));
        if let Some(folder) = &planned.folder_rename_old {
            let root = Path::new(request.space);
            moved_sources = crate::space::structural::collect_markdown_paths(
                root,
                &root.join(folder),
                &crate::files::tree_policy::TreeIgnorePolicy::from_space_root(root),
            )?;
            paths.extend(moved_sources.clone());
        }
        let mut targets = vec![request.path.to_string()];
        if let Some(folder) = &planned.folder_rename_old {
            targets.extend(backlinks.target_paths_under(folder));
        }
        let target_id = space_id_for_dir(state, request.space).await;
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
                    state
                        .space_path_of(Path::new(project), source.source_space_id.as_deref())
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

async fn publish(
    state: &IndexState,
    updates: &IndexUpdateState,
    backlinks: &BacklinkIndex,
    space: &str,
    project: Option<&str>,
    paths: &[PathBuf],
    original: &str,
    current: &str,
) -> Result<(), AppError> {
    checkpoint("projection")?;
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
                index::update::publish_managed_path(state, updates, project, path).await
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
            if let Err(error) = index::update::rebase_collection_schema_manifest(
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
        Err(AppError::Index(errors.join("; ")))
    }
}
