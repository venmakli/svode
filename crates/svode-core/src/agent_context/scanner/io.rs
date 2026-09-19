use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Path, PathBuf};

use crate::agent_adapters::AgentAdapterKind;

use super::super::model::{
    AgentContextDiagnostic, DiagnosticSeverity, MarkdownPreview, SourceLinkKind,
};

#[derive(Debug)]
pub(super) struct InspectedSource {
    pub canonical_path: Option<PathBuf>,
    pub link_kind: SourceLinkKind,
    pub preview: Option<MarkdownPreview>,
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
            ));
        }
    };
    if metadata.is_dir() {
        return Some(failed_inspection(
            path,
            adapter_id,
            "instruction_not_file",
            format!("Instruction entrypoint is not a file: {}", path.display()),
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
            ));
        }
    };
    let link_kind = if metadata.file_type().is_symlink() {
        SourceLinkKind::SymbolicLink
    } else if canonical_path != path {
        SourceLinkKind::DirectoryAlias
    } else {
        SourceLinkKind::Direct
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
            ));
        }
    };
    if !canonical_path.starts_with(&canonical_allowed_root) {
        return Some(InspectedSource {
            canonical_path: Some(canonical_path.clone()),
            link_kind,
            preview: None,
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
        ));
    }
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    Some(InspectedSource {
        canonical_path: Some(canonical_path),
        link_kind,
        preview: Some(MarkdownPreview {
            markdown: String::from_utf8_lossy(&bytes).into_owned(),
            truncated,
            bytes_read: bytes.len(),
            total_bytes,
        }),
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
) -> InspectedSource {
    InspectedSource {
        canonical_path: None,
        link_kind: SourceLinkKind::Direct,
        preview: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn direct_instruction_keeps_direct_link_kind() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let instruction = root.join("AGENTS.md");
        fs::write(&instruction, "direct").unwrap();

        let inspected = inspect(&instruction, &root, 1024, None).unwrap();

        assert_eq!(inspected.link_kind, SourceLinkKind::Direct);
        assert!(inspected.diagnostic.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn file_symlink_is_reported_as_symbolic_link_without_degrading_health() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = root.join("shared.md");
        let instruction = root.join("AGENTS.md");
        fs::write(&target, "linked").unwrap();
        symlink(&target, &instruction).unwrap();

        let inspected = inspect(&instruction, &root, 1024, None).unwrap();

        assert_eq!(inspected.link_kind, SourceLinkKind::SymbolicLink);
        assert_eq!(
            serde_json::to_value(inspected.link_kind).unwrap(),
            "symbolic_link"
        );
        assert_eq!(inspected.canonical_path.as_deref(), Some(target.as_path()));
        assert!(inspected.diagnostic.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn instruction_under_directory_root_alias_is_reported_as_directory_alias() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let real_root = root.join("real");
        let alias_root = root.join("alias");
        fs::create_dir(&real_root).unwrap();
        fs::write(real_root.join("AGENTS.md"), "aliased root").unwrap();
        symlink(&real_root, &alias_root).unwrap();

        let inspected = inspect(&alias_root.join("AGENTS.md"), &alias_root, 1024, None).unwrap();

        assert_eq!(inspected.link_kind, SourceLinkKind::DirectoryAlias);
        assert_eq!(
            serde_json::to_value(inspected.link_kind).unwrap(),
            "directory_alias"
        );
        assert!(inspected.diagnostic.is_none());
    }
}
