use std::path::Path;

use chrono::{SecondsFormat, Utc};

use super::model::{ResolvedRoutineOwner, RoutineOwnerInputKind};
use super::service;
use super::storage::RecoveryEvidence;
use crate::AppError;
use crate::index::{IndexKey, IndexState};
use crate::space::config;
use crate::space::types::{RoutinesLocalConfig, RoutinesRecoveryLocalConfig};

const STORAGE_GENERATION: u32 = 1;

pub(crate) fn read(owner: &ResolvedRoutineOwner) -> Result<bool, AppError> {
    read_key(&owner.space_path, &owner.identity())
}

pub(crate) fn read_indexed_collection(
    space_dir: &Path,
    index_key: &IndexKey,
    owner_path: &str,
) -> Result<bool, AppError> {
    read_key(
        space_dir,
        &ResolvedRoutineOwner::indexed_collection_identity(index_key, owner_path),
    )
}

fn read_key(space_dir: &Path, owner_key: &str) -> Result<bool, AppError> {
    let routines = config::read_local_config(space_dir)?
        .routines
        .unwrap_or_default();
    Ok(routines
        .automatic_authority
        .get(owner_key)
        .copied()
        .unwrap_or(false))
}

pub(crate) fn set(owner: &ResolvedRoutineOwner, enabled: bool) -> Result<bool, AppError> {
    let owner_key = owner.identity();
    config::mutate_local_config(&owner.space_path, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        if enabled {
            routines.recovery = None;
            routines.automatic_authority.insert(owner_key, true);
        } else {
            routines.automatic_authority.remove(&owner_key);
        }
        Ok(enabled)
    })
}

pub(crate) fn storage_was_created(space_dir: &Path) -> Result<bool, AppError> {
    Ok(config::read_local_config(space_dir)?
        .routines
        .and_then(|routines| routines.storage_generation)
        .is_some())
}

pub(crate) fn mark_storage_ready(space_dir: &Path) -> Result<(), AppError> {
    config::mutate_local_config(space_dir, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        routines.storage_generation = Some(STORAGE_GENERATION);
        Ok(())
    })
}

pub(crate) fn record_recovery(
    space_dir: &Path,
    evidence: RecoveryEvidence,
) -> Result<(), AppError> {
    config::mutate_local_config(space_dir, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        routines.automatic_authority.clear();
        routines.storage_generation = Some(STORAGE_GENERATION);
        routines.recovery = Some(RoutinesRecoveryLocalConfig {
            reason: evidence.reason.to_string(),
            observed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            quarantine_files: evidence.quarantine_files,
        });
        Ok(())
    })
}

pub(crate) fn recovery_required(space_dir: &Path) -> Result<bool, AppError> {
    Ok(config::read_local_config(space_dir)?
        .routines
        .is_some_and(|routines| routines.recovery.is_some()))
}

pub(crate) fn acknowledge_recovery(space_dir: &Path) -> Result<(), AppError> {
    config::mutate_local_config(space_dir, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        routines.automatic_authority.clear();
        routines.recovery = None;
        Ok(())
    })
}

pub(crate) async fn discover_project_owners(
    index_state: &IndexState,
    project_path: &Path,
) -> Result<Vec<ResolvedRoutineOwner>, AppError> {
    let project_path = project_path.to_path_buf();
    let mut owners = Vec::new();
    for key in index_state.routine_inventory_keys(&project_path).await? {
        let space_path = index_state.dir_for_key(&key).await?;
        let space_id = match &key {
            IndexKey::Root(_) => "root",
            IndexKey::Space { space_id, .. } => space_id,
        };
        owners.push(service::resolve_owner(
            &project_path,
            &space_path,
            space_id,
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )?);
        for owner_path in index_state.routine_owner_paths(&key).await? {
            owners.push(service::resolve_owner(
                &project_path,
                &space_path,
                space_id,
                &owner_path,
                RoutineOwnerInputKind::CollectionDirectory,
            )?);
        }
    }
    Ok(owners)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tempfile::tempdir;

    use super::*;
    use crate::routines::model::{RoutineOwnerDescriptor, RoutineOwnerKind};
    use crate::space::types::GitUserPolicy;

    fn owner(
        project_path: PathBuf,
        space_id: &str,
        kind: RoutineOwnerKind,
        owner_path: &str,
    ) -> ResolvedRoutineOwner {
        let space_path = if space_id == "root" {
            project_path.clone()
        } else {
            project_path.join(space_id)
        };
        ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind,
                space_id: space_id.into(),
                owner_path: owner_path.into(),
            },
            project_path: project_path.clone(),
            space_path: space_path.clone(),
            owner_root: space_path.join(owner_path),
            index_key: if space_id == "root" {
                IndexKey::Root(project_path)
            } else {
                IndexKey::Space {
                    project: project_path,
                    space_id: space_id.into(),
                }
            },
        }
    }

    #[test]
    fn exact_owner_values_are_local_and_default_off() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), "root", RoutineOwnerKind::Project, ".");
        let collection = owner(
            temp.path().into(),
            "root",
            RoutineOwnerKind::Collection,
            "tasks",
        );
        let renamed = owner(
            temp.path().into(),
            "root",
            RoutineOwnerKind::Collection,
            "renamed-tasks",
        );

        assert!(!read(&root).unwrap());
        assert!(set(&root, true).unwrap());
        assert!(set(&collection, true).unwrap());
        assert!(read(&root).unwrap());
        assert!(read(&collection).unwrap());
        assert!(!read(&renamed).unwrap());
        assert!(!set(&root, false).unwrap());
        assert!(!read(&root).unwrap());
        assert!(read(&collection).unwrap());
    }

    #[test]
    fn recovery_clears_authority_and_explicit_enable_resolves_the_notice() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), "root", RoutineOwnerKind::Project, ".");
        let collection = owner(
            temp.path().into(),
            "root",
            RoutineOwnerKind::Collection,
            "tasks",
        );
        assert!(set(&root, true).unwrap());
        assert!(set(&collection, true).unwrap());
        mark_storage_ready(temp.path()).unwrap();

        record_recovery(
            temp.path(),
            RecoveryEvidence {
                reason: "corrupt",
                quarantine_files: vec!["routines.db.corrupt-1".into()],
            },
        )
        .unwrap();

        assert!(recovery_required(temp.path()).unwrap());
        assert!(!read(&root).unwrap());
        assert!(!read(&collection).unwrap());

        assert!(set(&root, true).unwrap());
        assert!(!recovery_required(temp.path()).unwrap());
        assert!(read(&root).unwrap());
        assert!(!read(&collection).unwrap());
    }

    #[test]
    fn dismissing_recovery_keeps_every_authority_off() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), "root", RoutineOwnerKind::Project, ".");
        assert!(set(&root, true).unwrap());

        record_recovery(
            temp.path(),
            RecoveryEvidence {
                reason: "missing",
                quarantine_files: Vec::new(),
            },
        )
        .unwrap();

        acknowledge_recovery(temp.path()).unwrap();

        assert!(!recovery_required(temp.path()).unwrap());
        assert!(!read(&root).unwrap());
    }

    #[test]
    fn routine_mutations_preserve_other_local_config_owners() {
        let temp = tempdir().unwrap();
        config::write_git_user_policy(
            temp.path(),
            &GitUserPolicy {
                auto_sync: true,
                auto_commit_structural: false,
                auto_commit_system: true,
            },
        )
        .unwrap();
        let root = owner(temp.path().into(), "root", RoutineOwnerKind::Project, ".");

        set(&root, true).unwrap();

        assert!(config::read_git_user_policy(temp.path()).unwrap().auto_sync);
    }

    #[tokio::test]
    async fn missing_store_after_generation_marker_forces_recovery_and_authority_off() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), "root", RoutineOwnerKind::Project, ".");
        assert!(set(&root, true).unwrap());
        mark_storage_ready(temp.path()).unwrap();

        let state = IndexState::new();
        state.get_or_create_routines(&root.index_key).await.unwrap();

        assert!(recovery_required(temp.path()).unwrap());
        assert!(!read(&root).unwrap());
        assert!(
            config::read_local_config(temp.path())
                .unwrap()
                .routines
                .unwrap()
                .automatic_authority
                .is_empty()
        );
    }
}
