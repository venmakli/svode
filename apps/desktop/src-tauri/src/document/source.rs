use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::AppError;
use crate::attachments::source::resolve_registered_owner;
use crate::files::tree::child_folder_names;
use crate::repo_path::{RootMode, normalize_repo_relative};

const PDF_SOURCE_LIMIT: u64 = 64 * 1024 * 1024;
const DOCX_SOURCE_LIMIT: u64 = 32 * 1024 * 1024;
const XLSX_SOURCE_LIMIT: u64 = 32 * 1024 * 1024;
const PPTX_SOURCE_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DocumentFormat {
    Pdf,
    Docx,
    Xlsx,
    Pptx,
    Doc,
    Xls,
    Ppt,
    Docm,
    Xlsm,
    Pptm,
    Odt,
    Ods,
    Odp,
}

impl DocumentFormat {
    fn from_path(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        match extension.as_str() {
            "pdf" => Some(Self::Pdf),
            "docx" => Some(Self::Docx),
            "xlsx" => Some(Self::Xlsx),
            "pptx" => Some(Self::Pptx),
            "doc" => Some(Self::Doc),
            "xls" => Some(Self::Xls),
            "ppt" => Some(Self::Ppt),
            "docm" => Some(Self::Docm),
            "xlsm" => Some(Self::Xlsm),
            "pptm" => Some(Self::Pptm),
            "odt" => Some(Self::Odt),
            "ods" => Some(Self::Ods),
            "odp" => Some(Self::Odp),
            _ => None,
        }
    }

    fn source_limit(self) -> Option<u64> {
        match self {
            Self::Pdf => Some(PDF_SOURCE_LIMIT),
            Self::Docx => Some(DOCX_SOURCE_LIMIT),
            Self::Xlsx => Some(XLSX_SOURCE_LIMIT),
            Self::Pptx => Some(PPTX_SOURCE_LIMIT),
            Self::Doc
            | Self::Xls
            | Self::Ppt
            | Self::Docm
            | Self::Xlsm
            | Self::Pptm
            | Self::Odt
            | Self::Ods
            | Self::Odp => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentSourceDescriptor {
    pub format: DocumentFormat,
    pub size_bytes: u64,
    pub generation: String,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DocumentSourceError {
    #[error("Document source is missing")]
    SourceMissing,
    #[error("Document source is not accessible")]
    SourceInaccessible,
    #[error("This file is not a supported Document source")]
    UnsupportedFormat,
    #[error("Document source exceeds the {limit_bytes} byte preview limit")]
    ResourceLimit { limit_bytes: u64, actual_bytes: u64 },
    #[error("Document source changed while it was being opened")]
    SourceChanged,
    #[error("No application could open this Document")]
    ExternalOpenFailed,
}

impl Serialize for DocumentSourceError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct StructuredError<'a> {
            kind: &'static str,
            message: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            limit_bytes: Option<u64>,
            #[serde(skip_serializing_if = "Option::is_none")]
            actual_bytes: Option<u64>,
        }

        let (kind, limit_bytes, actual_bytes) = match self {
            Self::SourceMissing => ("source_missing", None, None),
            Self::SourceInaccessible => ("source_inaccessible", None, None),
            Self::UnsupportedFormat => ("unsupported_format", None, None),
            Self::ResourceLimit {
                limit_bytes,
                actual_bytes,
            } => ("resource_limit", Some(*limit_bytes), Some(*actual_bytes)),
            Self::SourceChanged => ("source_changed", None, None),
            Self::ExternalOpenFailed => ("external_open_failed", None, None),
        };
        let message = self.to_string();
        StructuredError {
            kind,
            message: &message,
            limit_bytes,
            actual_bytes,
        }
        .serialize(serializer)
    }
}

pub(crate) struct ResolvedDocumentSource {
    pub path: PathBuf,
    pub descriptor: DocumentSourceDescriptor,
}

pub(crate) fn inspect_document_source(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
) -> Result<ResolvedDocumentSource, DocumentSourceError> {
    resolve_document_source(project_path, space_id, target_path, true)
}

pub(crate) fn resolve_document_source_for_external(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
) -> Result<ResolvedDocumentSource, DocumentSourceError> {
    resolve_document_source(project_path, space_id, target_path, false)
}

fn resolve_document_source(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
    enforce_preview_limit: bool,
) -> Result<ResolvedDocumentSource, DocumentSourceError> {
    let owner = resolve_registered_owner(project_path, space_id).map_err(map_source_error)?;
    let space_root = fs::canonicalize(&owner.space_path).map_err(map_io_error)?;
    let normalized = normalize_repo_relative(target_path, RootMode::Reject)
        .map_err(|_| DocumentSourceError::SourceInaccessible)?;
    reject_registered_space_boundary(&space_root, &normalized)?;
    reject_symlink_components(&space_root, Path::new(&normalized))?;

    let candidate = space_root.join(&normalized);
    let metadata = fs::symlink_metadata(&candidate).map_err(map_io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DocumentSourceError::SourceInaccessible);
    }
    let canonical = fs::canonicalize(&candidate).map_err(map_io_error)?;
    if !canonical.starts_with(&space_root) {
        return Err(DocumentSourceError::SourceInaccessible);
    }
    let format =
        DocumentFormat::from_path(&canonical).ok_or(DocumentSourceError::UnsupportedFormat)?;
    if enforce_preview_limit
        && let Some(limit_bytes) = format.source_limit()
        && metadata.len() > limit_bytes
    {
        return Err(DocumentSourceError::ResourceLimit {
            limit_bytes,
            actual_bytes: metadata.len(),
        });
    }
    let descriptor = descriptor_from_metadata(format, &metadata)?;
    Ok(ResolvedDocumentSource {
        path: canonical,
        descriptor,
    })
}

pub(crate) fn read_document_source(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
    expected_generation: &str,
) -> Result<Vec<u8>, DocumentSourceError> {
    let resolved = inspect_document_source(project_path, space_id, target_path)?;
    if resolved.descriptor.generation != expected_generation {
        return Err(DocumentSourceError::SourceChanged);
    }
    let Some(limit_bytes) = resolved.descriptor.format.source_limit() else {
        return Err(DocumentSourceError::UnsupportedFormat);
    };
    let mut file = File::open(&resolved.path).map_err(map_io_error)?;
    let mut bytes = Vec::with_capacity(resolved.descriptor.size_bytes as usize);
    file.by_ref()
        .take(limit_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(map_io_error)?;
    if bytes.len() as u64 > limit_bytes {
        return Err(DocumentSourceError::ResourceLimit {
            limit_bytes,
            actual_bytes: bytes.len() as u64,
        });
    }
    let metadata = file.metadata().map_err(map_io_error)?;
    let after = descriptor_from_metadata(resolved.descriptor.format, &metadata)?;
    if after.generation != expected_generation || after.size_bytes != bytes.len() as u64 {
        return Err(DocumentSourceError::SourceChanged);
    }
    Ok(bytes)
}

fn descriptor_from_metadata(
    format: DocumentFormat,
    metadata: &fs::Metadata,
) -> Result<DocumentSourceDescriptor, DocumentSourceError> {
    let modified = metadata
        .modified()
        .map_err(map_io_error)?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DocumentSourceError::SourceInaccessible)?;
    let mut hasher = Sha256::new();
    hasher.update(format!("{format:?}").as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.as_secs().to_le_bytes());
    hasher.update(modified.subsec_nanos().to_le_bytes());
    let digest = hasher.finalize();
    Ok(DocumentSourceDescriptor {
        format,
        size_bytes: metadata.len(),
        generation: digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn reject_registered_space_boundary(
    space_path: &Path,
    normalized: &str,
) -> Result<(), DocumentSourceError> {
    let first = Path::new(normalized)
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().to_string());
    if first
        .as_ref()
        .is_some_and(|component| child_folder_names(space_path).contains(component))
    {
        return Err(DocumentSourceError::SourceInaccessible);
    }
    Ok(())
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), DocumentSourceError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(map_io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(DocumentSourceError::SourceInaccessible);
        }
    }
    Ok(())
}

fn map_source_error(error: AppError) -> DocumentSourceError {
    match error {
        AppError::FileNotFound(_) => DocumentSourceError::SourceMissing,
        AppError::Io(error) => map_io_error(error),
        _ => DocumentSourceError::SourceInaccessible,
    }
}

fn map_io_error(error: std::io::Error) -> DocumentSourceError {
    if error.kind() == std::io::ErrorKind::NotFound {
        DocumentSourceError::SourceMissing
    } else {
        DocumentSourceError::SourceInaccessible
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::SpaceConfig;

    fn write_project(path: &Path) {
        fs::create_dir_all(path).unwrap();
        write_space_config(
            path,
            &SpaceConfig {
                name: "Project".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn document_source_returns_exact_guarded_bytes() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        fs::write(temp.path().join("guide.pdf"), b"%PDF fixture").unwrap();
        let descriptor = inspect_document_source(temp.path(), None, "guide.pdf")
            .unwrap()
            .descriptor;
        let bytes =
            read_document_source(temp.path(), None, "guide.pdf", &descriptor.generation).unwrap();
        assert_eq!(bytes, b"%PDF fixture");
        assert_eq!(descriptor.format, DocumentFormat::Pdf);
    }

    #[test]
    fn document_source_rejects_traversal_and_unknown_formats() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        fs::write(temp.path().join("unknown.bin"), b"binary").unwrap();
        assert!(matches!(
            inspect_document_source(temp.path(), None, "../outside.pdf"),
            Err(DocumentSourceError::SourceInaccessible)
        ));
        assert!(matches!(
            inspect_document_source(temp.path(), None, "unknown.bin"),
            Err(DocumentSourceError::UnsupportedFormat)
        ));
    }

    #[test]
    fn read_rejects_stale_generation() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        fs::write(temp.path().join("guide.pdf"), b"first").unwrap();
        let descriptor = inspect_document_source(temp.path(), None, "guide.pdf")
            .unwrap()
            .descriptor;
        fs::write(temp.path().join("guide.pdf"), b"second generation").unwrap();
        assert!(matches!(
            read_document_source(temp.path(), None, "guide.pdf", &descriptor.generation),
            Err(DocumentSourceError::SourceChanged)
        ));
    }

    #[test]
    fn external_resolution_bypasses_preview_size_limit() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        let path = temp.path().join("large.pdf");
        File::create(&path)
            .unwrap()
            .set_len(PDF_SOURCE_LIMIT + 1)
            .unwrap();
        assert!(matches!(
            inspect_document_source(temp.path(), None, "large.pdf"),
            Err(DocumentSourceError::ResourceLimit { .. })
        ));
        assert!(resolve_document_source_for_external(temp.path(), None, "large.pdf").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn document_source_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), temp.path().join("linked.pdf")).unwrap();
        assert!(matches!(
            inspect_document_source(temp.path(), None, "linked.pdf"),
            Err(DocumentSourceError::SourceInaccessible)
        ));
    }
}
