use std::{collections::BTreeMap, io::Read, path::Path};

use serde::Serialize;
use tauri::State;

use super::{
    cli::{GitCli, read_bounded},
    commands::{GitState, require_cli},
    inspection::{InspectionScope, contained_file, is_binary_format},
    ops,
};
use crate::{
    AppError,
    repo_path::{RootMode, normalize_repo_relative},
};

const MAX_FILES: usize = 50;
const MAX_BYTES: usize = 512 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemStats {
    path: String,
    additions: Option<usize>,
    deletions: Option<usize>,
}

#[derive(Serialize)]
pub struct InspectionStats {
    generation: String,
    items: Vec<ItemStats>,
}

async fn git(cli: &GitCli, space: &Path, args: &[&str]) -> Result<Vec<u8>, AppError> {
    let (ok, bytes) = read_bounded(cli, space, args, MAX_BYTES).await?;
    if !ok || bytes.len() > MAX_BYTES {
        return Err(AppError::GitCommandFailed(
            "Change statistics unavailable".into(),
        ));
    }
    Ok(bytes)
}

pub(crate) async fn read_stats(
    cli: &GitCli,
    space: &Path,
    paths: Vec<String>,
    generation: String,
    scope: InspectionScope,
) -> Result<InspectionStats, AppError> {
    if paths.len() > MAX_FILES || generation.len() > 256 {
        return Err(AppError::GitCommandFailed(
            "Statistics batch exceeds its limit".into(),
        ));
    }
    for path in &paths {
        if normalize_repo_relative(path, RootMode::Reject)? != *path || !scope.contains(path)? {
            return Err(AppError::PathNotAccessible(
                "Source leaves inspection scope".into(),
            ));
        }
    }
    let status = ops::status(cli, space).await?;
    let states: BTreeMap<_, _> = status
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.state.as_str()))
        .collect();
    let (has_head, head) =
        read_bounded(cli, space, &["rev-parse", "--verify", "HEAD"], 256).await?;
    let head_id = String::from_utf8_lossy(&head).trim().to_string();
    let mut baseline = BTreeMap::new();
    if has_head && !paths.is_empty() {
        let mut args = vec!["--literal-pathspecs", "ls-tree", "-l", "-z", &head_id, "--"];
        args.extend(paths.iter().map(String::as_str));
        let entries = git(cli, space, &args).await?;
        let entries = String::from_utf8(entries)
            .map_err(|_| AppError::GitCommandFailed("Invalid baseline paths".into()))?;
        for entry in entries.split('\0').filter(|entry| !entry.is_empty()) {
            if let Some((info, path)) = entry.split_once('\t') {
                let fields: Vec<_> = info.split_whitespace().collect();
                let size = fields.last().and_then(|size| size.parse::<usize>().ok());
                baseline.insert(path.to_string(), (info.starts_with("100"), size));
            }
        }
    }
    let mut items: Vec<ItemStats> = paths
        .into_iter()
        .map(|path| ItemStats {
            path,
            ..Default::default()
        })
        .collect();
    let mut tracked = Vec::new();
    let mut snapshots = BTreeMap::new();
    for item in &mut items {
        let path = &item.path;
        if states
            .get(path.as_str())
            .is_none_or(|state| *state == "conflict")
            || is_binary_format(path)
        {
            continue;
        }
        let Ok(target) = contained_file(space, path) else {
            continue;
        };
        let metadata = std::fs::symlink_metadata(&target).ok();
        if has_nested_repository(space, path)
            || (states.get(path.as_str()) == Some(&"deleted") && metadata.is_some())
            || metadata
                .as_ref()
                .is_some_and(|meta| !meta.is_file() || meta.len() > MAX_BYTES as u64)
        {
            continue;
        }
        snapshots.insert(
            path.clone(),
            metadata
                .as_ref()
                .map(|meta| (meta.len(), meta.modified().ok())),
        );
        if let Some((regular, size)) = baseline.get(path) {
            if !regular || size.is_none_or(|size| size > MAX_BYTES) {
                continue;
            }
            tracked.push(path.as_str());
            item.additions = Some(0);
            item.deletions = Some(0);
        } else if let Ok(file) = std::fs::File::open(&target) {
            if !file.metadata()?.is_file() {
                continue;
            }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
            if bytes.len() <= MAX_BYTES && !bytes.contains(&0) {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    item.additions = Some(text.lines().count());
                    item.deletions = Some(0);
                }
            }
        }
    }
    if !tracked.is_empty() {
        // HEAD -> disk counts, independent of staging and user diff drivers.
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--numstat",
            "--relative",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            &head_id,
            "--",
        ];
        args.extend(tracked);
        let bytes = git(cli, space, &args).await?;
        let output = String::from_utf8(bytes)
            .map_err(|_| AppError::GitCommandFailed("Invalid statistics paths".into()))?;
        for record in output.split('\0').filter(|record| !record.is_empty()) {
            let mut fields = record.splitn(3, '\t');
            let additions = fields.next().and_then(|value| value.parse().ok());
            let deletions = fields.next().and_then(|value| value.parse().ok());
            if let Some(item) = fields
                .next()
                .and_then(|path| items.iter_mut().find(|item| item.path == path))
            {
                item.additions = additions;
                item.deletions = deletions;
            }
        }
    }
    let (still_has_head, current_head) =
        read_bounded(cli, space, &["rev-parse", "--verify", "HEAD"], 256).await?;
    if has_head != still_has_head || head != current_head {
        return Err(AppError::GitCommandFailed(
            "Baseline changed; retry statistics".into(),
        ));
    }
    for item in &mut items {
        let current = contained_file(space, &item.path)
            .ok()
            .and_then(|path| std::fs::symlink_metadata(path).ok());
        let current = current
            .as_ref()
            .map(|meta| (meta.len(), meta.modified().ok()));
        if snapshots.get(&item.path) != Some(&current) || has_nested_repository(space, &item.path) {
            item.additions = None;
            item.deletions = None;
        }
    }
    Ok(InspectionStats { generation, items })
}

fn has_nested_repository(space: &Path, path: &str) -> bool {
    let mut ancestor = space.to_path_buf();
    for part in path.split('/') {
        ancestor.push(part);
        if ancestor.join(".git").exists() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn git_inspection_stats(
    state: State<'_, GitState>,
    space_path: String,
    paths: Vec<String>,
    generation: String,
    scope: InspectionScope,
) -> Result<InspectionStats, AppError> {
    read_stats(
        &require_cli(&state)?,
        Path::new(&space_path),
        paths,
        generation,
        scope,
    )
    .await
}
