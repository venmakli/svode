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
