use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Path, PathBuf};

use crate::agent_adapters::AgentAdapterKind;

use super::super::model::{AgentContextDiagnostic, DiagnosticSeverity, MarkdownPreview};

#[derive(Debug)]
pub(super) struct InspectedSource {
    pub canonical_path: Option<PathBuf>,
    pub preview: Option<MarkdownPreview>,
    pub is_alias: bool,
    pub compatibility_unknown: bool,
    pub diagnostic: Option<AgentContextDiagnostic>,
}

pub(super) fn inspect(
    path: &Path,
    allowed_root: &Path,
    max_bytes: usize,
    adapter_id: Option<AgentAdapterKind>,
) -> Option<InspectedSource> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            return Some(failed_inspection(
                path,
                adapter_id,
                "instruction_metadata",
                format!("Could not inspect {}: {error}", path.display()),
                false,
            ));
        }
    };
    if metadata.is_dir() {
        return Some(failed_inspection(
            path,
            adapter_id,
            "instruction_not_file",
            format!("Instruction entrypoint is not a file: {}", path.display()),
            false,
        ));
    }

    let canonical_path = match fs::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(error) => {
            return Some(failed_inspection(
                path,
                adapter_id,
                "instruction_broken_alias",
                format!(
                    "Could not resolve instruction source {}: {error}",
                    path.display()
                ),
                true,
            ));
        }
    };
    let canonical_allowed_root = match fs::canonicalize(allowed_root) {
        Ok(root) => root,
        Err(error) => {
            return Some(failed_inspection(
                path,
                adapter_id,
                "instruction_owner_unavailable",
                format!(
                    "Could not resolve allowed instruction root {}: {error}",
                    allowed_root.display()
                ),
                true,
            ));
        }
    };
    let is_alias = metadata.file_type().is_symlink();
    if !canonical_path.starts_with(&canonical_allowed_root) {
        return Some(InspectedSource {
            canonical_path: Some(canonical_path.clone()),
            preview: None,
            is_alias: true,
            compatibility_unknown: true,
            diagnostic: Some(diagnostic(
                path,
                adapter_id,
                "instruction_outside_boundary",
                format!(
                    "Instruction alias {} resolves outside allowed root {}",
                    path.display(),
                    allowed_root.display()
                ),
            )),
        });
    }

    let total_bytes = match fs::metadata(&canonical_path) {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            return Some(failed_inspection(
                path,
                adapter_id,
                "instruction_read_metadata",
                format!("Could not read metadata for {}: {error}", path.display()),
                false,
            ));
        }
    };
    let mut bytes = Vec::with_capacity(max_bytes.saturating_add(1));
    let file = match File::open(&canonical_path) {
        Ok(file) => file,
        Err(error) => {
            return Some(failed_inspection(
                path,
                adapter_id,
                "instruction_read",
                format!("Could not read {}: {error}", path.display()),
                false,
            ));
        }
    };
    let limit = u64::try_from(max_bytes.saturating_add(1)).unwrap_or(u64::MAX);
    let mut reader: Take<File> = file.take(limit);
    if let Err(error) = reader.read_to_end(&mut bytes) {
        return Some(failed_inspection(
            path,
            adapter_id,
            "instruction_read",
            format!("Could not read {}: {error}", path.display()),
            false,
        ));
    }
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    Some(InspectedSource {
        canonical_path: Some(canonical_path),
        preview: Some(MarkdownPreview {
            markdown: String::from_utf8_lossy(&bytes).into_owned(),
            truncated,
            bytes_read: bytes.len(),
            total_bytes,
        }),
        is_alias,
        compatibility_unknown: false,
        diagnostic: truncated.then(|| {
            diagnostic(
                path,
                adapter_id,
                "instruction_preview_truncated",
                format!(
                    "Instruction preview for {} was limited to {max_bytes} bytes",
                    path.display()
                ),
            )
        }),
    })
}

fn failed_inspection(
    path: &Path,
    adapter_id: Option<AgentAdapterKind>,
    code: &str,
    message: String,
    compatibility_unknown: bool,
) -> InspectedSource {
    InspectedSource {
        canonical_path: None,
        preview: None,
        is_alias: true,
        compatibility_unknown,
        diagnostic: Some(diagnostic(path, adapter_id, code, message)),
    }
}

pub(super) fn diagnostic(
    path: &Path,
    adapter_id: Option<AgentAdapterKind>,
    code: &str,
    message: String,
) -> AgentContextDiagnostic {
    AgentContextDiagnostic {
        code: code.to_string(),
        severity: DiagnosticSeverity::Warning,
        message,
        path: Some(path_string(path)),
        adapter_id,
    }
}

pub(super) fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
