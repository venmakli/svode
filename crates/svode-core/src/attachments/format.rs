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

/// Whether `path` names an HTML file: `.html` or `.htm` in any case.
pub fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

/// The kind of a file directly in an attachments owner. An HTML file is a
/// Document, except inside an App directory, where it is a file of the App
/// (Stage 11 `06`); other files follow `classify_binary_extension`.
pub fn classify_attachment_file(
    path: &Path,
    inside_app: bool,
) -> Option<(ArtifactKind, AttachmentAvailability)> {
    if is_html_path(path) {
        return (!inside_app).then_some((ArtifactKind::Document, AttachmentAvailability::Limited));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    classify_binary_extension(&extension)
}

/// Whether `directory` or one of its ancestors up to and including
/// `space_root` holds a regular `app.yaml`: its files are those of an App.
pub fn is_inside_app(space_root: &Path, directory: &Path) -> bool {
    if !directory.starts_with(space_root) {
        return false;
    }
    directory
        .ancestors()
        .take_while(|ancestor| ancestor.starts_with(space_root))
        .any(|ancestor| {
            std::fs::symlink_metadata(ancestor.join("app.yaml"))
                .is_ok_and(|metadata| metadata.is_file())
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_is_a_document_outside_an_app() {
        for name in ["report.html", "REPORT.HTML", "page.htm", "Page.HtM"] {
            assert_eq!(
                classify_attachment_file(Path::new(name), false),
                Some((ArtifactKind::Document, AttachmentAvailability::Limited)),
                "{name}"
            );
            assert_eq!(
                classify_attachment_file(Path::new(name), true),
                None,
                "{name}"
            );
        }
        for name in ["page.xhtml", "page.html.md", "html"] {
            assert!(!is_html_path(Path::new(name)), "{name}");
        }
        // Other formats keep their kind inside an App.
        assert_eq!(
            classify_attachment_file(Path::new("guide.pdf"), true),
            classify_binary_extension("pdf")
        );
        assert_eq!(
            classify_attachment_file(Path::new("notes.txt"), false),
            None
        );
        // The binary classifier of imports and skill files is unchanged.
        assert_eq!(classify_binary_path(Path::new("report.html")), None);
    }

    #[test]
    fn an_app_directory_holds_its_subdirectories() {
        let temp = tempfile::tempdir().unwrap();
        let space = temp.path();
        let app = space.join("dashboard");
        std::fs::create_dir_all(app.join("public/assets")).unwrap();
        std::fs::create_dir_all(space.join("reports")).unwrap();
        std::fs::write(app.join("app.yaml"), "runtime: static").unwrap();

        assert!(is_inside_app(space, &app));
        assert!(is_inside_app(space, &app.join("public")));
        assert!(is_inside_app(space, &app.join("public/assets")));
        assert!(!is_inside_app(space, &space.join("reports")));
        assert!(!is_inside_app(space, space));
        // An `app.yaml` above the Space does not count.
        assert!(!is_inside_app(
            &app.join("public"),
            &app.join("public/assets")
        ));

        std::fs::write(space.join("app.yaml"), "runtime: static").unwrap();
        assert!(is_inside_app(space, &space.join("reports")));
    }
}
