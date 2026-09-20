use std::path::Path;

use chrono::{SecondsFormat, Utc};

use super::RoutineStoreError;
use super::local::{self, RoutinesLocalConfig, RoutinesRecoveryLocalConfig};
use super::storage::RecoveryEvidence;

const STORAGE_GENERATION: u32 = 1;

pub fn read_key(space_dir: &Path, owner_key: &str) -> Result<bool, RoutineStoreError> {
    let routines = local::read(space_dir)?.routines.unwrap_or_default();
    Ok(routines
        .automatic_authority
        .get(owner_key)
        .copied()
        .unwrap_or(false))
}

pub fn set_key(
    space_dir: &Path,
    owner_key: &str,
    enabled: bool,
) -> Result<bool, RoutineStoreError> {
    local::mutate(space_dir, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        if enabled {
            routines.recovery = None;
            routines
                .automatic_authority
                .insert(owner_key.to_owned(), true);
        } else {
            routines.automatic_authority.remove(owner_key);
        }
        Ok(enabled)
    })
    .map_err(Into::into)
}

pub fn storage_was_created(space_dir: &Path) -> Result<bool, RoutineStoreError> {
    Ok(local::read(space_dir)?
        .routines
        .and_then(|routines| routines.storage_generation)
        .is_some())
}

pub fn mark_storage_ready(space_dir: &Path) -> Result<(), RoutineStoreError> {
    local::mutate(space_dir, |local| {
        local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default)
            .storage_generation = Some(STORAGE_GENERATION);
        Ok(())
    })
    .map_err(Into::into)
}

pub fn record_recovery(
    space_dir: &Path,
    evidence: RecoveryEvidence,
) -> Result<(), RoutineStoreError> {
    local::mutate(space_dir, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        routines.automatic_authority.clear();
        routines.storage_generation = Some(STORAGE_GENERATION);
        routines.recovery = Some(RoutinesRecoveryLocalConfig {
            reason: evidence.reason.to_owned(),
            observed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            quarantine_files: evidence.quarantine_files,
        });
        Ok(())
    })
    .map_err(Into::into)
}

pub fn recovery_required(space_dir: &Path) -> Result<bool, RoutineStoreError> {
    Ok(local::read(space_dir)?
        .routines
        .is_some_and(|routines| routines.recovery.is_some()))
}

pub fn acknowledge_recovery(space_dir: &Path) -> Result<(), RoutineStoreError> {
    local::mutate(space_dir, |local| {
        let routines = local
            .routines
            .get_or_insert_with(RoutinesLocalConfig::default);
        routines.automatic_authority.clear();
        routines.recovery = None;
        Ok(())
    })
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tempfile::tempdir;

    use super::*;
    use crate::index::IndexKey;
    use crate::routines::local::GitUserPolicy;
    use crate::routines::model::{ResolvedRoutineOwner, RoutineOwnerDescriptor, RoutineOwnerKind};

    fn owner(project_path: PathBuf, kind: RoutineOwnerKind, owner_path: &str) -> String {
        ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind,
                space_id: "root".into(),
                owner_path: owner_path.into(),
            },
            project_path: project_path.clone(),
            space_path: project_path.clone(),
            owner_root: project_path.join(owner_path),
            index_key: IndexKey::Root(project_path),
        }
        .identity()
    }

    #[test]
    fn exact_owner_values_are_local_and_default_off() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), RoutineOwnerKind::Project, ".");
        let collection = owner(temp.path().into(), RoutineOwnerKind::Collection, "tasks");
        let renamed = owner(
            temp.path().into(),
            RoutineOwnerKind::Collection,
            "renamed-tasks",
        );

        assert!(!read_key(temp.path(), &root).unwrap());
        assert!(set_key(temp.path(), &root, true).unwrap());
        assert!(set_key(temp.path(), &collection, true).unwrap());
        assert!(read_key(temp.path(), &root).unwrap());
        assert!(read_key(temp.path(), &collection).unwrap());
        assert!(!read_key(temp.path(), &renamed).unwrap());
        assert!(!set_key(temp.path(), &root, false).unwrap());
        assert!(!read_key(temp.path(), &root).unwrap());
        assert!(read_key(temp.path(), &collection).unwrap());
    }

    #[test]
    fn recovery_clears_authority_and_explicit_enable_resolves_the_notice() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), RoutineOwnerKind::Project, ".");
        let collection = owner(temp.path().into(), RoutineOwnerKind::Collection, "tasks");
        assert!(set_key(temp.path(), &root, true).unwrap());
        assert!(set_key(temp.path(), &collection, true).unwrap());
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
        assert!(!read_key(temp.path(), &root).unwrap());
        assert!(!read_key(temp.path(), &collection).unwrap());

        assert!(set_key(temp.path(), &root, true).unwrap());
        assert!(!recovery_required(temp.path()).unwrap());
        assert!(read_key(temp.path(), &root).unwrap());
        assert!(!read_key(temp.path(), &collection).unwrap());
    }

    #[test]
    fn dismissing_recovery_keeps_every_authority_off() {
        let temp = tempdir().unwrap();
        let root = owner(temp.path().into(), RoutineOwnerKind::Project, ".");
        assert!(set_key(temp.path(), &root, true).unwrap());

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
        assert!(!read_key(temp.path(), &root).unwrap());
    }

    #[test]
    fn routine_mutations_preserve_other_local_config_owners() {
        let temp = tempdir().unwrap();
        crate::git::policy::write_user_policy(
            temp.path(),
            &GitUserPolicy {
                auto_sync: true,
                auto_commit_structural: false,
                auto_commit_system: true,
            },
        )
        .unwrap();
        let root = owner(temp.path().into(), RoutineOwnerKind::Project, ".");

        set_key(temp.path(), &root, true).unwrap();

        assert!(
            crate::git::policy::read_user_policy(temp.path())
                .unwrap()
                .auto_sync
        );
    }
}
