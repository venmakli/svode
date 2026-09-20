use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter};

use super::import::ManagedImportDelivery;

static MANAGED_IMPORT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn emit_managed_import_invalidations(app: &AppHandle, delivery: &ManagedImportDelivery) {
    let generation = MANAGED_IMPORT_GENERATION.fetch_add(1, Ordering::Relaxed);
    for owner_path in &delivery.owner_paths {
        let mut changes = vec![serde_json::json!({
            "path": delivery.attachment_path,
            "kind": "binary",
        })];
        if delivery.converted_page {
            changes.push(serde_json::json!({
                "path": delivery.canonical_content_path,
                "kind": "page",
            }));
        }
        if let Err(error) = app.emit(
            "attachments:invalidated",
            serde_json::json!({
                "spacePath": crate::system_path::user_facing_path(&delivery.space_path),
                "ownerPath": owner_path,
                "generation": generation,
                "changes": changes,
            }),
        ) {
            tracing::warn!("managed import invalidation failed: {error}");
        }
    }
}
