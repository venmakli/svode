use crate::error::AppError;
use crate::files::{EntryMeta, entry::Cover};
use serde::Serialize;
use std::collections::HashMap;

const FRONTMATTER_DELIMITER: &str = "---";

/// Parse a markdown file's content into (frontmatter, body).
/// Returns `Ok(Some((meta, body)))` on success, `Ok(None)` if no frontmatter found,
/// or `Err` if frontmatter is present but malformed.
pub fn try_parse(content: &str) -> Result<Option<(EntryMeta, String)>, AppError> {
    let trimmed = content.trim_start();

    if !trimmed.starts_with(FRONTMATTER_DELIMITER) {
        return Ok(None);
    }

    parse_inner(trimmed).map(Some)
}

/// Parse a markdown file's content into (frontmatter, body).
/// Returns an error if frontmatter is missing or malformed.
pub fn parse(content: &str) -> Result<(EntryMeta, String), AppError> {
    let trimmed = content.trim_start();

    if !trimmed.starts_with(FRONTMATTER_DELIMITER) {
        return Err(AppError::FrontmatterParse(
            "file does not start with frontmatter delimiter '---'".into(),
        ));
    }

    parse_inner(trimmed)
}

fn parse_inner(trimmed: &str) -> Result<(EntryMeta, String), AppError> {
    // Find the closing delimiter
    let after_first = &trimmed[FRONTMATTER_DELIMITER.len()..];
    let after_first = after_first.strip_prefix('\n').unwrap_or(after_first);

    let end_pos = after_first
        .find(&format!("\n{FRONTMATTER_DELIMITER}"))
        .ok_or_else(|| {
            AppError::FrontmatterParse("missing closing frontmatter delimiter '---'".into())
        })?;

    let yaml_str = &after_first[..end_pos];
    let body_start = end_pos + 1 + FRONTMATTER_DELIMITER.len();
    let body = after_first[body_start..]
        .strip_prefix('\n')
        .unwrap_or(&after_first[body_start..]);

    let meta: EntryMeta = serde_yml::from_str(yaml_str)
        .map_err(|e| AppError::FrontmatterParse(format!("invalid YAML frontmatter: {e}")))?;

    Ok((meta, body.to_string()))
}

/// Serialize frontmatter + body into a full markdown string.
pub fn serialize(meta: &EntryMeta, body: &str) -> String {
    let yaml = serde_yml::to_string(&FrontmatterMeta::from(meta)).unwrap_or_default();
    // serde_yml adds a trailing newline, so we don't need an extra one
    format!("---\n{yaml}---\n{body}")
}

#[derive(Serialize)]
struct FrontmatterMeta<'a> {
    id: &'a str,
    title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cover: Option<&'a Cover>,
    created: &'a str,
    updated: &'a str,
    #[serde(flatten)]
    extra: &'a HashMap<String, serde_yml::Value>,
}

impl<'a> From<&'a EntryMeta> for FrontmatterMeta<'a> {
    fn from(meta: &'a EntryMeta) -> Self {
        Self {
            id: &meta.id,
            title: &meta.title,
            icon: meta.icon.as_ref(),
            description: meta.description.as_ref(),
            cover: meta.cover.as_ref(),
            created: &meta.created,
            updated: &meta.updated,
            extra: &meta.extra,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let meta = EntryMeta {
            id: "01ABC".into(),
            title: "Hello World".into(),
            icon: None,
            description: Some("A short summary".into()),
            cover: Some(crate::files::entry::Cover::Color {
                value: crate::files::entry::ColorName::Blue,
            }),
            created: "2026-03-17T00:00:00Z".into(),
            updated: "2026-03-17T00:00:00Z".into(),
            extra: std::collections::HashMap::new(),
        };
        let body = "Some content here.\n";
        let raw = serialize(&meta, body);
        let (parsed_meta, parsed_body) = parse(&raw).unwrap();
        assert_eq!(parsed_meta.id, meta.id);
        assert_eq!(parsed_meta.title, meta.title);
        assert_eq!(parsed_meta.description, meta.description);
        assert_eq!(parsed_meta.cover, meta.cover);
        assert_eq!(parsed_body, body);
    }

    #[test]
    fn image_cover_roundtrip() {
        let raw = r#"---
id: 01ABC
title: With Cover
cover:
  type: image
  path: .assets/a1b2c3d4-cover.jpg
  position: 50
created: 2026-03-17T00:00:00Z
updated: 2026-03-17T00:00:00Z
---
Body
"#;

        let (parsed_meta, parsed_body) = parse(raw).unwrap();
        assert_eq!(
            parsed_meta.cover,
            Some(crate::files::entry::Cover::Image {
                path: ".assets/a1b2c3d4-cover.jpg".into(),
                position: Some(50),
            })
        );
        assert_eq!(parsed_body, "Body\n");
    }

    #[test]
    fn extra_fields_stay_flat_in_frontmatter() {
        let mut meta = EntryMeta {
            id: "01ABC".into(),
            title: "With Extra".into(),
            icon: None,
            description: None,
            cover: None,
            created: "2026-03-17T00:00:00Z".into(),
            updated: "2026-03-17T00:00:00Z".into(),
            extra: std::collections::HashMap::new(),
        };
        meta.extra
            .insert("Статус".into(), serde_yml::Value::String("В работе".into()));

        let raw = serialize(&meta, "Body\n");
        let (parsed_meta, _) = parse(&raw).unwrap();

        assert!(!raw.contains("\nextra:"));
        assert_eq!(parsed_meta.extra.get("Статус"), meta.extra.get("Статус"));
    }

    #[test]
    fn entry_meta_json_serialization_nests_extra_fields() {
        let mut meta = EntryMeta {
            id: "01ABC".into(),
            title: "With Extra".into(),
            icon: None,
            description: None,
            cover: None,
            created: "2026-03-17T00:00:00Z".into(),
            updated: "2026-03-17T00:00:00Z".into(),
            extra: std::collections::HashMap::new(),
        };
        meta.extra
            .insert("Статус".into(), serde_yml::Value::String("В работе".into()));

        let json = serde_json::to_value(&meta).unwrap();

        assert_eq!(json["extra"]["Статус"], "В работе");
        assert!(json.get("Статус").is_none());
    }
}
