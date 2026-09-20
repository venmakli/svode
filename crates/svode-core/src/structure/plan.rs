//! Touched-set planners. Each returns every path the matching operation may
//! write, so the caller authorizes the whole set before the first change.

use std::path::{Path, PathBuf};

use crate::collections::engine::{self, CollectionSchema};
use crate::index::state::IndexRuntimeState;
use crate::page::PageError;
use crate::page::entry;
use crate::storage::routes::managed_attachment_policy_paths;

pub async fn move_mutation_paths(
    state: &IndexRuntimeState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    to: &str,
) -> Result<Vec<PathBuf>, PageError> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        let mut paths = vec![PathBuf::from(space)];
        paths.extend(managed_attachment_policy_paths(space, None));
        return Ok(paths);
    };
    let mut paths =
        engine::relation_move_mutation_paths_with_project(space, Some(project), from, to)?;
    let space_id = state.space_id_for_dir(Path::new(space)).await;
    let link_plan = if Path::new(space).join(from).is_dir() {
        state
            .plan_links_on_folder_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    } else {
        state
            .plan_links_on_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    };
    paths.extend_from_slice(link_plan.mutation_paths());
    paths.extend(managed_attachment_policy_paths(space, Some(project)));
    paths.push(PathBuf::from(space));
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub async fn backlink_mutation_paths(
    state: &IndexRuntimeState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<Vec<PathBuf>, PageError> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return Ok(vec![PathBuf::from(space)]);
    };
    let space_id = state.space_id_for_dir(Path::new(space)).await;
    let plan = if folder_rename {
        state
            .plan_links_on_folder_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    } else {
        state
            .plan_links_on_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    };
    let mut paths = plan.mutation_paths().to_vec();
    paths.push(PathBuf::from(space));
    Ok(paths)
}

/// Re-plan the backlink touched-set and confirm it is still covered by the
/// authorization taken before the operation started.
pub(crate) async fn revalidate_backlink_plan(
    state: &IndexRuntimeState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<(), PageError> {
    let paths = backlink_mutation_paths(state, space, project_path, from, folder_rename).await?;
    Ok(crate::git::access::ensure_mutation_paths_were_authorized(
        &paths,
    )?)
}

pub fn delete_mutation_paths(
    space: &str,
    project_path: Option<&str>,
    path: &str,
) -> Result<Vec<PathBuf>, PageError> {
    let deleted = entry::planned_deleted_entry_paths(space, path)?;
    let mut paths = engine::cascade_clean_deleted_entries_mutation_paths_with_project(
        space,
        project_path.filter(|path| !path.is_empty()),
        &deleted,
    )?;
    paths.push(PathBuf::from(space));
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub fn collection_create_schema_paths(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    schema: CollectionSchema,
    allocate_unique_title: bool,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, PageError> {
    let (parent, _) = super::ops::resolved_create_parent(space, parent_path)?;
    let planned = entry::planned_source_create(
        space,
        parent.as_deref(),
        title,
        allocate_unique_title,
        false,
    )?;
    let collection_path = planned
        .path
        .strip_suffix(".md")
        .ok_or_else(|| PageError::General("Collection Page must be Markdown".into()))?;
    Ok(
        engine::prepare_initial_collection_schema(space, collection_path, schema, project_path)?
            .paths()
            .to_vec(),
    )
}
