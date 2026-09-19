use std::path::Path;
use std::sync::{Arc, OnceLock};

use crate::index::state::IndexRuntimeState;
use crate::index::update::IndexUpdateState;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::entry::EntryMeta;
use crate::page::frontmatter;
use crate::page::nonce::WriteNonceRegistry;
use crate::page::write::PageRuntime;
use crate::routines::store_state::RoutineStoreState;

/// Minimal inline Space layout: config, local config and home README.
pub(crate) fn scaffold_space(path: &Path, name: &str) {
    std::fs::create_dir_all(path.join(".svode")).unwrap();
    std::fs::write(
        path.join(".svode/config.json"),
        format!(
            "{{\n  \"name\": \"{name}\",\n  \"description\": \"\",\n  \"icon\": \"\u{1F4C1}\"\n}}"
        ),
    )
    .unwrap();
    std::fs::write(path.join(".svode/local.json"), "{}").unwrap();
    std::fs::write(
        path.join("README.md"),
        frontmatter::serialize(&EntryMeta::new_persisted(name.to_string()), ""),
    )
    .unwrap();
}

pub(crate) fn update_state() -> &'static IndexUpdateState {
    static STATE: OnceLock<IndexUpdateState> = OnceLock::new();
    STATE.get_or_init(|| IndexUpdateState::new(Arc::new(RoutineStoreState::new())))
}

/// A Page runtime over fresh index state and nonce registry, without Git
/// date lookup.
pub(crate) fn runtime<'a>(
    index: &'a IndexRuntimeState,
    nonces: &'a WriteNonceRegistry,
) -> PageRuntime<'a, SystemGitDateExecutor> {
    PageRuntime {
        index,
        updates: update_state(),
        nonces,
        git_dates: None,
    }
}
