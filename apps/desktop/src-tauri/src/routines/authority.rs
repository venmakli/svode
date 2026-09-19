use std::path::Path;

use super::model::{ResolvedRoutineOwner, RoutineOwnerInputKind};
use super::service;
use crate::AppError;
use crate::index::{IndexKey, IndexState};
use crate::routines::RoutineStoreState;
#[cfg(test)]
use crate::space::config;
#[cfg(test)]
use svode_core::routines::storage::RecoveryEvidence;

pub(crate) fn read(owner: &ResolvedRoutineOwner) -> Result<bool, AppError> {
    Ok(svode_core::routines::authority::read_key(
        &owner.space_path,
        &owner.identity(),
    )?)
}

pub(crate) fn set(owner: &ResolvedRoutineOwner, enabled: bool) -> Result<bool, AppError> {
    Ok(svode_core::routines::authority::set_key(
        &owner.space_path,
        &owner.identity(),
        enabled,
    )?)
}

#[cfg(test)]
pub(crate) fn mark_storage_ready(space_dir: &Path) -> Result<(), AppError> {
    Ok(svode_core::routines::authority::mark_storage_ready(
        space_dir,
    )?)
}

#[cfg(test)]
pub(crate) fn record_recovery(
    space_dir: &Path,
    evidence: RecoveryEvidence,
) -> Result<(), AppError> {
    Ok(svode_core::routines::authority::record_recovery(
        space_dir, evidence,
    )?)
}

pub(crate) fn recovery_required(space_dir: &Path) -> Result<bool, AppError> {
    Ok(svode_core::routines::authority::recovery_required(
        space_dir,
    )?)
}

pub(crate) fn acknowledge_recovery(space_dir: &Path) -> Result<(), AppError> {
    Ok(svode_core::routines::authority::acknowledge_recovery(
        space_dir,
    )?)
}

pub(crate) async fn discover_project_owners(
    routine_stores: &RoutineStoreState,
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
        for owner_path in routine_stores.owner_paths(index_state, &key).await? {
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
