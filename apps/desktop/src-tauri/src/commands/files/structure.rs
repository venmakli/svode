//! Tauri adapters for nesting and entry-shape conversions.

use super::*;
#[tauri::command]
pub async fn nest_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    let new_path = entry::nest_entry(
        Path::new(&space),
        &path,
        if project_path.as_deref().filter(|p| !p.is_empty()).is_some() {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        let mut modified_sources = index_state
            .update_links_on_rename_project(
                project,
                target_space_id.as_deref(),
                &path,
                &new_path,
                None,
            )
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("cross-space nest backlink rewrite failed: {e}");
                Vec::new()
            });
        modified_sources.extend(
            rebase_project_source_after_move(
                &index_state,
                project_path.as_deref(),
                &space,
                target_space_id.as_deref(),
                &path,
                &new_path,
                "nest_entry",
            )
            .await,
        );
        let modified_sources = crate::files::backlinks::dedupe_modified_sources(modified_sources);
        schedule_modified_source_spaces(
            &index_state,
            &autocommit,
            project_path.as_deref(),
            &modified_sources,
            StructuralOp::Move(entry_commit_name(&space, &new_path)),
        )
        .await;
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &path)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(&space, &backlink_index, &path, &new_path);
    }
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(entry_commit_name(&space, &new_path)),
        entry_paths_with_order(
            &space,
            [
                abs_entry_path(&space, &path),
                abs_entry_path(&space, &new_path),
            ],
        ),
    );
    Ok(new_path)
}

#[tauri::command]
pub async fn unnest_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    unnest_entry_shared(
        &space,
        &path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await
}

pub async fn unnest_entry_shared(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(index_state, project_path).await;
    let new_path = entry::unnest_entry(
        Path::new(space),
        path,
        if project_path.filter(|p| !p.is_empty()).is_some() {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(index_state, space).await;
        let mut modified_sources = index_state
            .update_links_on_rename_project(
                project,
                target_space_id.as_deref(),
                path,
                &new_path,
                None,
            )
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("cross-space unnest backlink rewrite failed: {e}");
                Vec::new()
            });
        modified_sources.extend(
            rebase_project_source_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                path,
                &new_path,
                "unnest_entry",
            )
            .await,
        );
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
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), path)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlink_index, path, &new_path);
    }
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::Move(entry_commit_name(space, &new_path)),
            entry_paths_with_order(
                space,
                [
                    abs_entry_path(space, path),
                    abs_entry_path(space, &new_path),
                ],
            ),
        );
    }
    Ok(new_path)
}

#[tauri::command]
pub async fn convert_entry_to_folder(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    convert_entry_to_folder_shared(
        &space,
        &file_path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await
}

pub async fn convert_entry_to_folder_shared(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let backlink_index = backlinks_for_space(index_state, space).await;
    ensure_backlinks_before_structural(index_state, project_path).await;
    let project_aware = project_path.filter(|path| !path.is_empty()).is_some();
    let entry = entry::convert_entry_to_folder(
        Path::new(space),
        file_path,
        if project_aware {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    let folder_root = root_path_for_head(&entry.path);
    let old_leaf = format!("{folder_root}.md");
    if let Some(proj) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(index_state, space).await;
        let mut modified_sources = index_state
            .update_links_on_rename_project(
                project,
                target_space_id.as_deref(),
                &old_leaf,
                &entry.path,
                None,
            )
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("cross-space convert-to-folder backlink rewrite failed: {e}");
                Vec::new()
            });
        modified_sources.extend(
            rebase_project_source_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                &old_leaf,
                &entry.path,
                "convert_entry_to_folder",
            )
            .await,
        );
        let modified_sources = crate::files::backlinks::dedupe_modified_sources(modified_sources);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                index_state,
                autocommit,
                project_path,
                &modified_sources,
                StructuralOp::ConvertToFolder(entry_history_commit_name(space, &entry.path)),
            )
            .await;
        }
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &old_leaf)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &entry.path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlink_index, &old_leaf, &entry.path);
    }
    replace_index_entries_or_reindex(
        index_state,
        project_path,
        space,
        &[old_leaf.clone()],
        std::slice::from_ref(&entry.path),
        "convert_entry_to_folder",
    )
    .await;
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::ConvertToFolder(entry_history_commit_name(space, &entry.path)),
            entry_paths_with_order(
                space,
                [
                    abs_entry_path(space, &old_leaf),
                    abs_entry_path(space, &entry.path),
                ],
            ),
        );
    }
    Ok(entry)
}

#[tauri::command]
pub async fn convert_to_collection(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<ConvertToCollectionCommandResult, AppError> {
    convert_to_collection_shared(
        &space,
        &path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await
}

pub async fn convert_to_collection_shared(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<ConvertToCollectionCommandResult, AppError> {
    let old_path = normalize_repo_relative(path, RootMode::Reject)?;
    let source_abs = Path::new(space).join(&old_path);
    let metadata = fs::metadata(&source_abs).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => AppError::FileNotFound(old_path.clone()),
        _ => AppError::Io(error),
    })?;

    let (collection_path, readme_path, entry, source_moved) = if metadata.is_dir() {
        let readme_path = format!("{old_path}/README.md");
        let schema_path = schema_path(space, &old_path);
        if schema_path.exists() {
            return Err(AppError::FileAlreadyExists(rel_changed_path(
                space,
                &schema_path,
            )));
        }
        if source_abs.join("README.md").exists() {
            let collection_path =
                entry::convert_entry_to_nested_collection(Path::new(space), &readme_path)?;
            let entry = entry::read(space, &readme_path)?;
            (collection_path, readme_path, entry, false)
        } else {
            let entry = entry::convert_bare_folder_to_collection(Path::new(space), &old_path)?;
            (old_path.clone(), readme_path, entry, false)
        }
    } else if metadata.is_file() {
        let parent_schema = source_abs.parent().map(|parent| parent.join("schema.yaml"));
        let is_readme = source_abs
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
        if is_readme && parent_schema.as_ref().is_some_and(|schema| schema.exists()) {
            return Err(AppError::General(format!(
                "{old_path} is already a collection README.md; convert_to_collection cannot convert an existing collection"
            )));
        }

        if is_readme {
            let collection_path = Path::new(&old_path)
                .parent()
                .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            entry::convert_entry_to_nested_collection(Path::new(space), &old_path)?;
            let entry = entry::read(space, &old_path)?;
            (collection_path, old_path.clone(), entry, false)
        } else {
            let entry = convert_entry_to_folder_shared(
                space,
                &old_path,
                project_path,
                index_state,
                autocommit,
            )
            .await?;
            let readme_path = entry.path.clone();
            let collection_path = Path::new(&readme_path)
                .parent()
                .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                .ok_or_else(|| {
                    AppError::General("converted entry has no collection folder".to_string())
                })?;
            entry::convert_entry_to_nested_collection(Path::new(space), &readme_path)?;
            let entry = entry::read(space, &readme_path)?;
            (collection_path, readme_path, entry, true)
        }
    } else {
        return Err(AppError::General(format!(
            "path must reference a markdown document or folder: {old_path}"
        )));
    };

    let schema_path_rel = collection_schema_path_rel(&collection_path);
    update_index_tree_or_reindex(
        index_state,
        project_path,
        space,
        &collection_path,
        "convert_to_collection",
    )
    .await;

    if let Some(autocommit) = autocommit {
        let mut paths = vec![
            abs_entry_path(space, &readme_path),
            schema_path(space, &collection_path),
        ];
        if source_moved {
            paths = entry_paths_with_order(space, paths);
            paths.push(abs_entry_path(space, &old_path));
        }
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::MakeCollection(entry_history_commit_name(space, &readme_path)),
            paths,
        );
    }

    Ok(ConvertToCollectionCommandResult {
        old_path,
        collection_path,
        readme_path,
        schema_path: schema_path_rel,
        entry,
    })
}

#[tauri::command]
pub async fn convert_entry_to_leaf(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    convert_entry_to_leaf_shared(
        &space,
        &file_path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await
}

pub async fn convert_entry_to_leaf_shared(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    index_state: &IndexState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(index_state, project_path).await;
    let project_aware = project_path.filter(|p| !p.is_empty()).is_some();
    let entry = entry::convert_entry_to_leaf(
        Path::new(space),
        file_path,
        if project_aware {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    let old_readme = entry
        .path
        .strip_suffix(".md")
        .map(|root| format!("{root}/README.md"))
        .unwrap_or_else(|| entry.path.clone());
    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(index_state, space).await;
        let mut modified_sources = index_state
            .update_links_on_rename_project(
                project,
                target_space_id.as_deref(),
                &old_readme,
                &entry.path,
                None,
            )
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("cross-space convert-to-leaf backlink rewrite failed: {e}");
                Vec::new()
            });
        modified_sources.extend(
            rebase_project_source_after_move(
                index_state,
                project_path,
                space,
                target_space_id.as_deref(),
                &old_readme,
                &entry.path,
                "convert_entry_to_leaf",
            )
            .await,
        );
        let modified_sources = crate::files::backlinks::dedupe_modified_sources(modified_sources);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                index_state,
                autocommit,
                project_path,
                &modified_sources,
                StructuralOp::ConvertToLeaf(entry_history_commit_name(space, &entry.path)),
            )
            .await;
        }
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &old_readme)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &entry.path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlink_index, &old_readme, &entry.path);
    }
    replace_index_entries_or_reindex(
        index_state,
        project_path,
        space,
        &[old_readme.clone()],
        std::slice::from_ref(&entry.path),
        "convert_entry_to_leaf",
    )
    .await;
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::ConvertToLeaf(entry_history_commit_name(space, &entry.path)),
            entry_paths_with_order(
                space,
                [
                    abs_entry_path(space, &old_readme),
                    abs_entry_path(space, &entry.path),
                ],
            ),
        );
    }
    Ok(entry)
}

#[tauri::command]
pub async fn convert_entry_to_nested_collection(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    convert_to_collection_shared(
        &space,
        &file_path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn convert_bare_folder_to_collection(
    space: String,
    folder_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    Ok(convert_to_collection_shared(
        &space,
        &folder_path,
        project_path.as_deref(),
        &index_state,
        Some(&autocommit),
    )
    .await?
    .entry)
}

#[tauri::command]
pub async fn duplicate_entry(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let old_name = entry_history_commit_name(&space, &file_path);
    let entry = entry::duplicate_entry(Path::new(&space), &file_path)?;
    update_index_tree_or_reindex(
        &index_state,
        project_path.as_deref(),
        &space,
        root_path_for_head(&entry.path),
        "duplicate_entry",
    )
    .await;
    let unique_id_paths =
        properties::unique_id_mutation_paths_for_entry_tree(Path::new(&space), &entry.path)?;
    if unique_id_paths.is_empty() {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Duplicate {
                old: old_name,
                new: entry_history_commit_name(&space, &entry.path),
            },
            entry_paths_with_order(
                &space,
                [abs_entry_path(&space, root_path_for_head(&entry.path))],
            ),
        );
    } else {
        let mut paths = entry_paths_with_order(
            &space,
            [abs_entry_path(&space, root_path_for_head(&entry.path))],
        );
        paths.extend(unique_id_paths);
        maybe_autocommit_schema(
            &autocommit,
            project_path.as_deref(),
            &space,
            paths,
            if entry_in_sensitive_collection(&space, &file_path)
                || entry_in_sensitive_collection(&space, &entry.path)
            {
                "Duplicate collection entry".to_string()
            } else {
                format!("Duplicate {old_name} → {}", entry_history_name(&entry.path))
            },
        )
        .await;
    }
    Ok(entry)
}
