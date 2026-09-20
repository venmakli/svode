//! Portable attachment format facts: which binary extensions Svode treats as
//! attachments, how available they are in the app, and their canonical MIME.

use std::path::Path;

use serde::Serialize;

use crate::page::identity::ArtifactKind;

/// How usable an attachment of this format is inside the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentAvailability {
    Available,
    Limited,
    ExternalOnly,
}

pub fn classify_binary_path(path: &Path) -> Option<ArtifactKind> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    classify_binary_extension(&extension).map(|(kind, _)| kind)
}

pub fn classify_binary_extension(
    extension: &str,
) -> Option<(ArtifactKind, AttachmentAvailability)> {
    let document = match extension {
        "pdf" | "docx" | "xlsx" | "pptx" => Some(AttachmentAvailability::Limited),
        "doc" | "xls" | "ppt" | "docm" | "xlsm" | "pptm" | "odt" | "ods" | "odp" => {
            Some(AttachmentAvailability::ExternalOnly)
        }
        _ => None,
    };
    if let Some(availability) = document {
        return Some((ArtifactKind::Document, availability));
    }

    matches!(
        extension,
        "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "svg"
            | "mp3"
            | "wav"
            | "m4a"
            | "aac"
            | "flac"
            | "ogg"
            | "opus"
            | "mp4"
            | "m4v"
            | "mov"
            | "webm"
            | "mkv"
            | "avi"
            | "wmv"
            | "mpg"
            | "mpeg"
            | "3gp"
            | "wma"
            | "aiff"
            | "avif"
            | "ico"
    )
    .then_some((ArtifactKind::Media, AttachmentAvailability::Limited))
}

/// Map an extension (lowercased, no dot) to the canonical MIME type.
pub fn mime_for(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
