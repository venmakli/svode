//! Tauri adapters for entry reads, writes, and structural mutations.

use super::*;

#[tauri::command]
pub fn list_entries(space: String) -> Result<Vec<TreeNode>, AppError> {
    let started = Instant::now();
    let space_name = path_name(&space);
    let result = tree::build_tree(&space);
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(nodes) => tracing::info!(
            target: "svode::perf",
            event = "list_entries",
            space = %space_name,
            node_count = count_tree_nodes(nodes),
            duration_ms,
            "list_entries completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "list_entries",
            space = %space_name,
            duration_ms,
            error_kind = error.kind(),
            "list_entries failed"
        ),
    }

    result
}

#[tauri::command]
pub fn list_tree_children(
    space: String,
    parent_path: Option<String>,
) -> Result<Vec<tree::TreeChildNode>, AppError> {
    let started = Instant::now();
    let space_name = path_name(&space);
    let parent_scope = if parent_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .is_some()
    {
        "child"
    } else {
        "root"
    };
    let result = tree::list_tree_children(&space, parent_path.as_deref());
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(nodes) => tracing::info!(
            target: "svode::perf",
            event = "list_tree_children",
            space = %space_name,
            parent_scope,
            node_count = nodes.len(),
            duration_ms,
            "list_tree_children completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "list_tree_children",
            space = %space_name,
            parent_scope,
            duration_ms,
            error_kind = error.kind(),
            "list_tree_children failed"
        ),
    }

    result
}

#[tauri::command]
pub fn get_entry_detail_state(
    space: String,
    path: String,
) -> Result<entry::EntryDetailState, AppError> {
    entry::entry_detail_state(Path::new(&space), &path)
}

#[tauri::command]
pub async fn create_entry(
    space: String,
    parent_path: Option<String>,
    title: String,
    contextual_defaults: Option<HashMap<String, serde_json::Value>>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let contextual_defaults = contextual_defaults
        .map(|defaults| {
            defaults
                .into_iter()
                .map(|(field, value)| Ok((field, json_to_yaml_value(value)?)))
                .collect::<Result<HashMap<_, _>, AppError>>()
        })
        .transpose()?;
    let created = if let Some(contextual_defaults) = contextual_defaults {
        entry::create_with_contextual_defaults(
            &space,
            parent_path.as_deref(),
            &title,
            Some(contextual_defaults),
        )?
    } else {
        entry::create(&space, parent_path.as_deref(), &title)?
    };
    update_index_entry_or_reindex(
        &index_state,
        project_path.as_deref(),
        &space,
        &created.path,
        "create_entry",
    )
    .await;
    if properties::unique_id_schema_path_for_entry(&space, &created.path)?.is_some() {
        let mut paths = properties::unique_id_mutation_paths_for_entry(&space, &created.path)?;
        paths.push(order_path(&space));
        let message = if entry_in_sensitive_collection(&space, &created.path) {
            "Create collection entry with unique_id".to_string()
        } else {
            format!("Create {} with unique_id", basename(&created.path))
        };
        maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    } else {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Create(entry_commit_name(&space, &created.path)),
            entry_paths_with_order(&space, [abs_entry_path(&space, &created.path)]),
        );
    }
    Ok(created)
}

#[tauri::command]
pub fn create_folder(
    space: String,
    parent_path: Option<String>,
    name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let folder_path = entry::create_folder(&space, parent_path.as_deref(), &name)?;
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Create(entry_commit_name(&space, &folder_path)),
        entry_paths_with_order(&space, [abs_entry_path(&space, &folder_path)]),
    );
    Ok(folder_path)
}

#[tauri::command]
pub async fn read_entry(
    space: String,
    path: String,
    index_state: State<'_, IndexState>,
) -> Result<Entry, AppError> {
    let mut entry = entry::read(&space, &path)?;
    let dates = indexed_entry_dates(&index_state, &space, &path).await;
    apply_indexed_dates(&mut entry, dates);
    Ok(entry)
}

#[tauri::command]
pub fn get_entry_schema(
    space: String,
    file_path: String,
) -> Result<Option<EntrySchemaResponse>, AppError> {
    properties::schema_response(&space, &file_path)
}

#[tauri::command]
pub async fn update_entry_field(
    space: String,
    file_path: String,
    field: String,
    value: serde_json::Value,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Entry, AppError> {
    let updated = entry::update_field(&space, project_path.as_deref(), &file_path, &field, value)?;

    update_index_entry_or_reindex(
        &index_state,
        project_path.as_deref(),
        &space,
        &file_path,
        "update_entry_field",
    )
    .await;

    Ok(updated)
}

#[tauri::command]
pub async fn write_entry(
    space: String,
    path: String,
    content: String,
    title: Option<String>,
    icon: Option<String>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    existing_id: Option<String>,
    skip_rename: Option<bool>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    nonces: State<'_, Arc<WriteNonceRegistry>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<WriteResult, AppError> {
    let skip_rename = skip_rename.unwrap_or(false);
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    let project = project_path.as_deref().filter(|p| !p.is_empty());
    let project_aware = project.is_some();
    if project_aware && !skip_rename {
        ensure_backlinks_before_structural(&index_state, project).await;
    }
    let mut result = entry::write(
        &space,
        &path,
        &content,
        title.as_deref(),
        icon.as_deref(),
        extra,
        existing_id.as_deref(),
        if project_aware {
            None
        } else {
            Some(&backlink_index)
        },
        skip_rename,
    )?;

    // Register the write-nonce against the canonical post-rename path so the
    // watcher can echo-guard the `file:changed` event that our own write
    // produces. Fall back to the join if canonicalize fails (e.g. path was
    // deleted between the write and here).
    let result_rel = result.new_path.as_deref().unwrap_or(&path);
    let joined = Path::new(&space).join(result_rel);
    let canonical = std::fs::canonicalize(&joined).unwrap_or(joined);
    nonces.register(canonical, result.write_nonce.clone());

    // Update SQLite index for the (possibly renamed) target path. Resolves
    // through IndexState to the owning pool (root or per-space DB).
    // On rename: delete the stale row first, then upsert the new path. The
    // reverse order would let a concurrent write to the new path get clobbered
    // by the stale-row delete.
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        if !skip_rename {
            if let Some(ref new_path) = result.new_path {
                match index_state
                    .update_links_on_rename_project(
                        project,
                        target_space_id.as_deref(),
                        &path,
                        new_path,
                        title.as_deref(),
                    )
                    .await
                {
                    Ok(modified) => {
                        result.modified_files = modified.iter().map(|m| m.path.clone()).collect();
                        result.modified_sources = modified.clone();
                        schedule_modified_source_spaces(
                            &index_state,
                            &autocommit,
                            project_path.as_deref(),
                            &modified,
                            entry_rename_op(&space, &path, new_path),
                        )
                        .await;
                    }
                    Err(e) => tracing::warn!("cross-space backlink rewrite failed: {e}"),
                }

                let is_readme = Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));
                if is_readme {
                    let old_folder = Path::new(&path)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string());
                    let new_folder = Path::new(new_path)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string());
                    if let (Some(of), Some(nf)) = (old_folder, new_folder) {
                        if !of.is_empty() && of != nf {
                            match index_state
                                .update_links_on_folder_rename_project(
                                    project,
                                    target_space_id.as_deref(),
                                    &of,
                                    &nf,
                                )
                                .await
                            {
                                Ok(extra) => {
                                    schedule_modified_source_spaces(
                                        &index_state,
                                        &autocommit,
                                        project_path.as_deref(),
                                        &extra,
                                        entry_rename_op(&space, &of, &nf),
                                    )
                                    .await;
                                    for item in extra {
                                        if !result.modified_sources.contains(&item) {
                                            result.modified_files.push(item.path.clone());
                                            result.modified_sources.push(item);
                                        }
                                    }
                                }
                                Err(e) => tracing::warn!(
                                    "cross-space folder backlink rewrite failed: {e}"
                                ),
                            }
                        }
                    }
                }
            }
        }

        if result.new_path.is_some() {
            if let Err(e) = index_state
                .remove_file_backlinks(project, target_space_id.as_deref(), &path)
                .await
            {
                tracing::warn!("remove stale backlinks source failed for {path}: {e}");
            }
        }
        let current = result.new_path.as_deref().unwrap_or(&path);
        if let Err(e) = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), current)
            .await
        {
            tracing::warn!("update file backlinks failed for {current}: {e}");
        }

        let target = result.new_path.clone().unwrap_or_else(|| path.clone());
        let deleted_paths = result
            .new_path
            .as_ref()
            .map(|_| vec![path.clone()])
            .unwrap_or_default();
        replace_index_entries_or_reindex(
            &index_state,
            project_path.as_deref(),
            &space,
            &deleted_paths,
            std::slice::from_ref(&target),
            "write_entry",
        )
        .await;
    }

    // On ⌘S-path rename, schedule the structural commit so `git_commit_file`'s
    // flush can drain it before the user-commit (Rename before Update).
    if !skip_rename {
        if let Some(ref new_path) = result.new_path {
            maybe_autocommit_structural_paths(
                &autocommit,
                project_path.as_deref(),
                &space,
                entry_rename_op(&space, &path, new_path),
                entry_paths_with_order(
                    &space,
                    [
                        abs_entry_path(&space, &path),
                        abs_entry_path(&space, new_path),
                    ],
                ),
            );
        }
    }

    Ok(result)
}

pub async fn delete_entry_shared(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<DeleteEntryCommandResult, AppError> {
    let backlink_index = backlinks_for_space(index_state, space).await;
    let deleted = entry::delete_with_project(
        space,
        path,
        Some(&backlink_index),
        project_path.filter(|path| !path.is_empty()),
    )?;
    let cascade_touched_by_space =
        grouped_abs_paths_by_space(project_path, space, &deleted.cascade_touched);
    let cascade_touched = deleted
        .cascade_touched
        .iter()
        .map(|path| rel_changed_path(space, path))
        .collect::<Vec<_>>();
    let mut changed_paths = Vec::new();
    for deleted_path in &deleted.deleted_paths {
        push_unique_path(&mut changed_paths, deleted_path.clone());
    }
    push_unique_path(&mut changed_paths, deleted.deleted_root.clone());
    for touched in &cascade_touched {
        push_unique_path(&mut changed_paths, touched.clone());
    }

    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let source_space_id = space_id_for_dir(index_state, space).await;
        let mut needs_reindex = false;
        for deleted_path in &deleted.deleted_paths {
            if let Err(e) = index_state
                .remove_file_backlinks(project, source_space_id.as_deref(), deleted_path)
                .await
            {
                tracing::warn!("remove backlinks for deleted entry failed: {e}");
            }
            let abs_old = Path::new(space).join(deleted_path);
            if let Err(e) = index::update::delete_entry(index_state, project, &abs_old).await {
                tracing::warn!("index delete_entry failed for {deleted_path}: {e}");
                needs_reindex = true;
            } else {
                tracing::debug!(
                    event = "index.update.targeted",
                    context = "delete_entry",
                    operation = "delete",
                    path = deleted_path
                );
            }
        }
        if needs_reindex {
            tracing::info!("delete_entry: running index.reindex.repair fallback");
            reindex_space_dir(index_state, space).await;
        } else if !deleted.cascade_touched.is_empty() {
            for (owner_space, paths) in &cascade_touched_by_space {
                update_index_paths_or_reindex(
                    index_state,
                    Some(proj),
                    &owner_space.to_string_lossy(),
                    paths.clone(),
                    "delete_entry",
                )
                .await;
            }
        }
    } else {
        reindex_space_dir(index_state, space).await;
    }
    if let Some(autocommit) = autocommit {
        let current_space = PathBuf::from(space);
        let mut paths_by_space = cascade_touched_by_space;
        paths_by_space
            .entry(current_space.clone())
            .or_default()
            .extend(entry_paths_with_order(
                space,
                [abs_entry_path(space, &deleted.deleted_root)],
            ));
        let op = StructuralOp::Delete(entry_commit_name(space, path));
        for (owner_space, paths) in paths_by_space {
            maybe_autocommit_structural_paths(
                autocommit,
                project_path,
                &owner_space.to_string_lossy(),
                op.clone(),
                paths,
            );
        }
    }
    Ok(DeleteEntryCommandResult {
        deleted_root: deleted.deleted_root,
        deleted_paths: deleted.deleted_paths,
        cascade_touched,
        changed_paths,
    })
}

#[tauri::command]
pub async fn delete_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    delete_entry_shared(
        &space,
        &path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    space: String,
    from: String,
    to: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<String>, AppError> {
    rename_entry_shared(
        &space,
        &from,
        &to,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await
}

pub async fn rename_entry_shared(
    space: &str,
    from: &str,
    to: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<Vec<String>, AppError> {
    let from_parent = Path::new(from).parent().unwrap_or(Path::new(""));
    let to_parent = Path::new(to).parent().unwrap_or(Path::new(""));
    if from_parent != to_parent {
        return Err(AppError::General(
            "rename_entry cannot change parent; use move_entry to move an entry".to_string(),
        ));
    }
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    let was_dir = Path::new(&space).join(&from).is_dir();
    ensure_backlinks_before_structural(index_state, project_path).await;
    entry::rename_with_project(space, from, to, project_path)?;
    let modified = if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(index_state, space).await;
        let mut modified_sources = if was_dir {
            index_state
                .update_links_on_folder_rename_project(
                    project,
                    target_space_id.as_deref(),
                    from,
                    to,
                )
                .await
        } else {
            index_state
                .update_links_on_rename_project(project, target_space_id.as_deref(), from, to, None)
                .await
        }
        .unwrap_or_else(|e| {
            tracing::warn!("cross-space rename backlink rewrite failed: {e}");
            Vec::new()
        });
        let rebased = if was_dir {
            rebase_project_source_tree_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                from,
                to,
                "rename_entry",
            )
            .await
        } else if !same_parent(&from, &to) {
            rebase_project_source_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                from,
                to,
                "rename_entry",
            )
            .await
        } else {
            Vec::new()
        };
        modified_sources.extend(rebased);
        let modified_sources = crate::files::backlinks::dedupe_modified_sources(modified_sources);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                index_state,
                autocommit,
                project_path,
                &modified_sources,
                entry_rename_op(space, from, to),
            )
            .await;
        }
        if !was_dir {
            let _ = index_state
                .remove_file_backlinks(project, target_space_id.as_deref(), from)
                .await;
            let _ = index_state
                .update_file_backlinks(project, target_space_id.as_deref(), to)
                .await;
        }
        modified_sources.iter().map(|m| m.path.clone()).collect()
    } else {
        let modified = backlink_index
            .update_links_on_rename(Path::new(space), from, to, None)
            .unwrap_or_default();
        let mut modified = modified;
        if was_dir {
            rebase_legacy_source_tree_after_move(space, &backlink_index, from, to);
        } else if !same_parent(from, to) {
            if rebase_legacy_source_after_move(space, &backlink_index, from, to).unwrap_or(false)
                && !modified.iter().any(|path| path == to)
            {
                modified.push(to.to_string());
            }
        }
        let _ = backlink_index.update_file(Path::new(space), to);
        modified
    };
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            entry_rename_op(space, from, to),
            entry_paths_with_order(
                space,
                [abs_entry_path(space, from), abs_entry_path(space, to)],
            ),
        );
    }
    Ok(modified)
}

#[tauri::command]
pub async fn move_entry(
    space: String,
    from: String,
    to_parent: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    move_entry_shared(
        &space,
        &from,
        &to_parent,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await
}

pub async fn move_entry_shared(
    space: &str,
    from: &str,
    to_parent: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    let was_dir = Path::new(&space).join(&from).is_dir();
    let old_abs = Path::new(space).join(from);
    ensure_backlinks_before_structural(index_state, project_path).await;
    let new_path = entry::move_entry_with_project(
        Path::new(space),
        from,
        to_parent,
        if project_path.filter(|p| !p.is_empty()).is_some() {
            None
        } else {
            Some(&backlink_index)
        },
        project_path,
    )?;
    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(index_state, space).await;
        let mut modified_sources = if was_dir {
            index_state
                .update_links_on_folder_rename_project(
                    project,
                    target_space_id.as_deref(),
                    from,
                    &new_path,
                )
                .await
        } else {
            index_state
                .update_links_on_rename_project(
                    project,
                    target_space_id.as_deref(),
                    from,
                    &new_path,
                    None,
                )
                .await
        }
        .unwrap_or_else(|e| {
            tracing::warn!("cross-space move backlink rewrite failed: {e}");
            Vec::new()
        });
        let rebased = if was_dir {
            rebase_project_source_tree_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                from,
                &new_path,
                "move_entry",
            )
            .await
        } else {
            rebase_project_source_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                from,
                &new_path,
                "move_entry",
            )
            .await
        };
        modified_sources.extend(rebased);
        let modified_sources = crate::files::backlinks::dedupe_modified_sources(modified_sources);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                index_state,
                autocommit,
                project_path,
                &modified_sources,
                StructuralOp::Move(entry_commit_name(space, &new_path)),
            )
            .await;
        }
        if !was_dir {
            let _ = index_state
                .remove_file_backlinks(project, target_space_id.as_deref(), from)
                .await;
            let _ = index_state
                .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
                .await;
        }
    } else if was_dir {
        rebase_legacy_source_tree_after_move(space, &backlink_index, from, &new_path);
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlink_index, from, &new_path);
    }
    let mut unique_id_paths =
        properties::unique_id_mutation_paths_for_entry_tree(Path::new(space), &new_path)?;
    if unique_id_paths.is_empty() {
        if let Some(autocommit) = autocommit {
            maybe_autocommit_structural_paths(
                autocommit,
                project_path,
                space,
                StructuralOp::Move(entry_commit_name(space, &new_path)),
                entry_paths_with_order(space, [old_abs.clone(), abs_entry_path(space, &new_path)]),
            );
        }
    } else {
        unique_id_paths.push(old_abs);
        unique_id_paths.push(abs_entry_path(space, &new_path));
        unique_id_paths.push(order_path(space));
        if let Some(autocommit) = autocommit {
            maybe_autocommit_schema(
                autocommit,
                project_path,
                space,
                unique_id_paths,
                if entry_in_sensitive_collection(space, &new_path) {
                    "Move collection entry with unique_id".to_string()
                } else {
                    format!("Move {} with unique_id", basename(&new_path))
                },
            )
            .await;
        }
    }
    Ok(new_path)
}

#[tauri::command]
pub async fn get_backlinks(
    space: String,
    target_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<BacklinkInfo>, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        index_state
            .ensure_project_backlinks_built(Path::new(proj))
            .await?;
    } else if !backlink_index.is_built() {
        backlink_index.build(Path::new(&space))?;
    }
    Ok(backlink_index.get_backlinks(&target_path))
}

#[tauri::command]
pub async fn rebuild_backlinks(
    space: String,
    index_state: State<'_, IndexState>,
) -> Result<(), AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    backlink_index.build(Path::new(&space))
}

#[tauri::command]
pub async fn validate_links(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<LinkValidation>, AppError> {
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let source_space_id = space_id_for_dir(&index_state, &space).await;
        let abs = Path::new(&space).join(&path);
        if !abs.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(abs)?;
        let links = crate::files::backlinks::parse_markdown_links(&content);
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (url, _) in links {
            if !seen.insert(url.clone()) {
                continue;
            }
            let resolved = index_state
                .resolve_doc_link(Path::new(proj), source_space_id.as_deref(), &path, &url)
                .await?;
            out.push(LinkValidation {
                url,
                exists: resolved.exists,
            });
        }
        Ok(out)
    } else {
        crate::files::backlinks::validate_links(Path::new(&space), &path)
    }
}

#[tauri::command]
pub fn watch_space(
    space: String,
    app: AppHandle,
    watcher: State<'_, FileWatcher>,
) -> Result<(), AppError> {
    watcher.watch(space, app)
}

#[tauri::command]
pub fn unwatch_space(space: String, watcher: State<'_, FileWatcher>) -> Result<(), AppError> {
    watcher.unwatch(&space)
}
