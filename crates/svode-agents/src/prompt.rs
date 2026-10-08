//! Prompt content (Stage 10 `02` C6): an ordered sequence of text and links
//! to files and directories. A link is never a copy of the file: the agent
//! reads it with its own tools; an image also goes as an image block when
//! the agent declares image prompts, so the model sees it where it was
//! written.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::AgentRuntimeError;
use crate::activity::MessageSegment;

/// Image bytes one prompt block may carry; a larger image goes as its link
/// only.
const IMAGE_LIMIT: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PromptPart {
    Text {
        text: String,
    },
    /// A file or a directory by its absolute path, with the name its badge
    /// shows.
    File {
        path: PathBuf,
        name: String,
    },
}

impl PromptPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}

/// A prompt block before it becomes the ACP wire shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PromptBlock {
    Text(String),
    Link {
        uri: String,
        name: String,
        mime_type: Option<&'static str>,
    },
    Image {
        uri: String,
        mime_type: &'static str,
        /// Base64 of the file.
        data: String,
    },
}

/// Refuses a prompt that links a file or a directory that is not there,
/// before a new session is created for it.
pub fn check(parts: &[PromptPart]) -> Result<(), AgentRuntimeError> {
    for part in parts {
        if let PromptPart::File { path, .. } = part {
            file(path)?;
        }
    }
    Ok(())
}

/// The blocks of a prompt in order. A link to a file that is not there is
/// refused before anything is sent; an image follows its link as an image
/// block when the agent declares image prompts and the file is within the
/// bound. A directory is a link only.
pub(crate) fn blocks(
    parts: &[PromptPart],
    images: bool,
) -> Result<Vec<PromptBlock>, AgentRuntimeError> {
    let mut blocks = Vec::with_capacity(parts.len());
    for part in parts {
        match part {
            PromptPart::Text { text } => blocks.push(PromptBlock::Text(text.clone())),
            PromptPart::File { path, name } => {
                let metadata = file(path)?;
                let uri = link_uri(path);
                let mime_type = image_mime_type(path).filter(|_| metadata.is_file());
                blocks.push(PromptBlock::Link {
                    uri: uri.clone(),
                    name: name.clone(),
                    mime_type,
                });
                if let Some(mime_type) = mime_type
                    && images
                    && metadata.len() <= IMAGE_LIMIT
                {
                    let bytes = std::fs::read(path).map_err(|_| unavailable(path))?;
                    blocks.push(PromptBlock::Image {
                        uri,
                        mime_type,
                        data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    });
                }
            }
        }
    }
    Ok(blocks)
}

/// A linked file: an absolute path to a file or a directory that is there.
fn file(path: &Path) -> Result<std::fs::Metadata, AgentRuntimeError> {
    match std::fs::metadata(path) {
        Ok(metadata) if path.is_absolute() && (metadata.is_file() || metadata.is_dir()) => {
            Ok(metadata)
        }
        _ => Err(unavailable(path)),
    }
}

/// The `file://` URI a link sends: a directory's ends with `/`, so the
/// agent and a replay of the message tell it from a file.
fn link_uri(path: &Path) -> String {
    let mut uri = file_uri(path);
    if !uri.ends_with('/') && path.is_dir() {
        uri.push('/');
    }
    uri
}

fn unavailable(path: &Path) -> AgentRuntimeError {
    AgentRuntimeError::FileUnavailable {
        path: path.display().to_string(),
    }
}

/// The user message the prompt becomes: its text, where a link reads as
/// `@name`, and its segments in order once it links a file.
pub(crate) fn message(parts: &[PromptPart]) -> (String, Vec<MessageSegment>) {
    let mut text = String::new();
    let mut segments = Vec::with_capacity(parts.len());
    for part in parts {
        match part {
            PromptPart::Text { text: part } => {
                text.push_str(part);
                segments.push(MessageSegment::Text { text: part.clone() });
            }
            PromptPart::File { path, name } => {
                text.push('@');
                text.push_str(name);
                segments.push(MessageSegment::Link {
                    uri: link_uri(path),
                    name: name.clone(),
                });
            }
        }
    }
    if segments
        .iter()
        .all(|segment| matches!(segment, MessageSegment::Text { .. }))
    {
        segments.clear();
    }
    (text, segments)
}

/// The image types agents accept in an image block, by file extension.
fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// An absolute `file://` URI of `path`, percent-encoded.
pub(crate) fn file_uri(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    let mut uri = String::from("file://");
    if !path.starts_with('/') {
        uri.push('/');
    }
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                uri.push(byte as char)
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_uri_is_absolute_and_percent_encoded() {
        assert_eq!(
            file_uri(Path::new("/Users/me/Мои файлы/a b#1.md")),
            "file:///Users/me/%D0%9C%D0%BE%D0%B8%20%D1%84%D0%B0%D0%B9%D0%BB%D1%8B/a%20b%231.md"
        );
        assert_eq!(
            file_uri(Path::new("C:\\work\\a.md")),
            "file:///C:/work/a.md"
        );
    }

    #[test]
    fn blocks_keep_the_order_and_an_image_follows_its_link_only_with_the_capability() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        let shot = dir.path().join("shot.PNG");
        std::fs::write(&note, "# Note").unwrap();
        std::fs::write(&shot, [137, 80, 78, 71]).unwrap();
        let parts = [
            PromptPart::text("Compare "),
            PromptPart::File {
                path: note.clone(),
                name: "note.md".into(),
            },
            PromptPart::text(" with "),
            PromptPart::File {
                path: shot.clone(),
                name: "shot.PNG".into(),
            },
        ];
        let link = |path: &Path, name: &str, mime_type| PromptBlock::Link {
            uri: file_uri(path),
            name: name.into(),
            mime_type,
        };
        assert_eq!(
            blocks(&parts, true).unwrap(),
            [
                PromptBlock::Text("Compare ".into()),
                link(&note, "note.md", None),
                PromptBlock::Text(" with ".into()),
                link(&shot, "shot.PNG", Some("image/png")),
                PromptBlock::Image {
                    uri: file_uri(&shot),
                    mime_type: "image/png",
                    data: "iVBORw==".into(),
                },
            ]
        );
        let without_images = blocks(&parts, false).unwrap();
        assert_eq!(without_images.len(), 4);
        assert_eq!(
            without_images[3],
            link(&shot, "shot.PNG", Some("image/png"))
        );
    }

    #[test]
    fn a_link_to_a_missing_or_relative_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for path in [dir.path().join("gone.md"), PathBuf::from("notes")] {
            let parts = [PromptPart::File {
                path: path.clone(),
                name: "x".into(),
            }];
            assert_eq!(
                blocks(&parts, true),
                Err(AgentRuntimeError::FileUnavailable {
                    path: path.display().to_string()
                })
            );
        }
    }

    #[test]
    fn a_directory_is_a_link_ending_with_a_slash_without_an_image() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("shots.png");
        std::fs::create_dir(&folder).unwrap();
        let parts = [PromptPart::File {
            path: folder.clone(),
            name: "shots.png".into(),
        }];
        let uri = format!("{}/", file_uri(&folder));
        assert_eq!(
            blocks(&parts, true).unwrap(),
            [PromptBlock::Link {
                uri: uri.clone(),
                name: "shots.png".into(),
                mime_type: None,
            }]
        );
        assert_eq!(
            message(&parts).1,
            [MessageSegment::Link {
                uri,
                name: "shots.png".into()
            }]
        );
        assert!(check(&parts).is_ok());
    }

    #[test]
    fn the_message_names_links_and_keeps_segments_only_when_it_links_a_file() {
        assert_eq!(
            message(&[PromptPart::text("just text")]),
            ("just text".into(), Vec::new())
        );
        let (text, segments) = message(&[
            PromptPart::text("See "),
            PromptPart::File {
                path: "/p/a.md".into(),
                name: "a.md".into(),
            },
        ]);
        assert_eq!(text, "See @a.md");
        assert_eq!(
            segments,
            [
                MessageSegment::Text {
                    text: "See ".into()
                },
                MessageSegment::Link {
                    uri: "file:///p/a.md".into(),
                    name: "a.md".into()
                },
            ]
        );
    }
}
