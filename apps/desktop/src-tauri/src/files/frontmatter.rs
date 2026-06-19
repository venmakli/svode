use crate::error::AppError;
use crate::files::{
    EntryMeta,
    entry::{Cover, FrontmatterKeys},
};
use std::collections::HashMap;

const FRONTMATTER_DELIMITER: &str = "---";

pub enum ParseStatus {
    Missing { body: String },
    Valid { meta: EntryMeta, body: String },
    Malformed { message: String, body: String },
}

struct FrontmatterParts<'a> {
    yaml: &'a str,
    body: &'a str,
    body_start: usize,
}

/// Parse a markdown file's content into (frontmatter, body).
/// Returns `Ok(Some((meta, body)))` on success, `Ok(None)` if no frontmatter found,
/// or `Err` if frontmatter is present but malformed.
pub fn try_parse(content: &str) -> Result<Option<(EntryMeta, String)>, AppError> {
    match parse_status(content) {
        ParseStatus::Missing { .. } => Ok(None),
        ParseStatus::Valid { meta, body } => Ok(Some((meta, body))),
        ParseStatus::Malformed { message, .. } => Err(AppError::FrontmatterParse(message)),
    }
}

/// Parse a markdown file's content into (frontmatter, body).
/// Returns an error if frontmatter is missing or malformed.
pub fn parse(content: &str) -> Result<(EntryMeta, String), AppError> {
    match parse_status(content) {
        ParseStatus::Valid { meta, body } => Ok((meta, body)),
        ParseStatus::Missing { .. } => Err(AppError::FrontmatterParse(
            "file does not start with frontmatter delimiter '---'".into(),
        )),
        ParseStatus::Malformed { message, .. } => Err(AppError::FrontmatterParse(message)),
    }
}

pub fn parse_status(content: &str) -> ParseStatus {
    if !content.trim_start().starts_with(FRONTMATTER_DELIMITER) {
        return ParseStatus::Missing {
            body: content.to_string(),
        };
    }

    match split_frontmatter(content).and_then(|parts| {
        let meta = parse_yaml_meta(parts.yaml)?;
        Ok((meta, parts.body.to_string()))
    }) {
        Ok((meta, body)) => ParseStatus::Valid { meta, body },
        Err(error) => ParseStatus::Malformed {
            message: match error {
                AppError::FrontmatterParse(message) => message,
                other => other.to_string(),
            },
            body: content.to_string(),
        },
    }
}

pub fn replace_body_preserving_frontmatter(content: &str, body: &str) -> Result<String, AppError> {
    let parts = split_frontmatter(content)?;
    Ok(format!("{}{}", &content[..parts.body_start], body))
}

fn split_frontmatter(content: &str) -> Result<FrontmatterParts<'_>, AppError> {
    let leading_len = content.len() - content.trim_start().len();
    let trimmed = &content[leading_len..];
    if !trimmed.starts_with(FRONTMATTER_DELIMITER) {
        return Err(AppError::FrontmatterParse(
            "file does not start with frontmatter delimiter '---'".into(),
        ));
    }

    let after_first = &trimmed[FRONTMATTER_DELIMITER.len()..];
    let skipped_newline = after_first.starts_with('\n');
    let after_first = if skipped_newline {
        &after_first[1..]
    } else {
        after_first
    };
    let yaml_start =
        leading_len + FRONTMATTER_DELIMITER.len() + if skipped_newline { 1 } else { 0 };

    let end_pos = after_first
        .find(&format!("\n{FRONTMATTER_DELIMITER}"))
        .ok_or_else(|| {
            AppError::FrontmatterParse("missing closing frontmatter delimiter '---'".into())
        })?;

    let yaml_str = &after_first[..end_pos];
    let closing_start = yaml_start + end_pos + 1;
    let closing_end = closing_start + FRONTMATTER_DELIMITER.len();
    let body_start = if content[closing_end..].starts_with('\n') {
        closing_end + 1
    } else {
        closing_end
    };

    Ok(FrontmatterParts {
        yaml: yaml_str,
        body: &content[body_start..],
        body_start,
    })
}

fn parse_yaml_meta(yaml_str: &str) -> Result<EntryMeta, AppError> {
    let value: serde_yml::Value = serde_yml::from_str(yaml_str)
        .map_err(|e| AppError::FrontmatterParse(format!("invalid YAML frontmatter: {e}")))?;
    let mapping = match value {
        serde_yml::Value::Null => serde_yml::Mapping::new(),
        serde_yml::Value::Mapping(mapping) => mapping,
        _ => {
            return Err(AppError::FrontmatterParse(
                "invalid YAML frontmatter: expected a mapping".into(),
            ));
        }
    };

    let mut frontmatter_keys = FrontmatterKeys::default();
    let mut title = None;
    let mut icon = None;
    let mut description = None;
    let mut cover = None;
    let mut extra = HashMap::new();

    for (key, value) in mapping {
        let serde_yml::Value::String(key) = key else {
            return Err(AppError::FrontmatterParse(
                "invalid YAML frontmatter: keys must be strings".into(),
            ));
        };

        match key.as_str() {
            "title" => {
                frontmatter_keys.title = true;
                title = Some(parse_string(value, "title")?);
            }
            "icon" => {
                frontmatter_keys.icon = true;
                icon = parse_optional_string(value, "icon")?;
            }
            "description" => {
                frontmatter_keys.description = true;
                description = parse_optional_string(value, "description")?;
            }
            "cover" => {
                frontmatter_keys.cover = true;
                cover = parse_optional_cover(value)?;
            }
            custom => {
                extra.insert(custom.to_string(), value);
            }
        }
    }

    Ok(EntryMeta::from_frontmatter(
        title.unwrap_or_default(),
        icon,
        description,
        cover,
        extra,
        frontmatter_keys,
    ))
}

fn parse_string(value: serde_yml::Value, field: &str) -> Result<String, AppError> {
    serde_yml::from_value(value)
        .map_err(|e| AppError::FrontmatterParse(format!("invalid YAML frontmatter: {field}: {e}")))
}

fn parse_optional_string(value: serde_yml::Value, field: &str) -> Result<Option<String>, AppError> {
    if value.is_null() {
        return Ok(None);
    }
    parse_string(value, field).map(Some)
}

fn parse_optional_cover(value: serde_yml::Value) -> Result<Option<Cover>, AppError> {
    if value.is_null() {
        return Ok(None);
    }
    serde_yml::from_value(value)
        .map(Some)
        .map_err(|e| AppError::FrontmatterParse(format!("invalid YAML frontmatter: cover: {e}")))
}

/// Serialize frontmatter + body into a full markdown string.
pub fn serialize(meta: &EntryMeta, body: &str) -> String {
    let yaml = serialize_yaml(meta);
    // serde_yml adds a trailing newline, so we don't need an extra one
    format!("---\n{yaml}---\n{body}")
}

fn serialize_yaml(meta: &EntryMeta) -> String {
    let mut mapping = serde_yml::Mapping::new();
    if meta.frontmatter_keys.title {
        mapping.insert(
            serde_yml::Value::String("title".into()),
            serde_yml::Value::String(meta.title.clone()),
        );
    }
    if meta.frontmatter_keys.icon {
        if let Some(icon) = meta.icon.clone() {
            mapping.insert(
                serde_yml::Value::String("icon".into()),
                serde_yml::Value::String(icon),
            );
        }
    }
    if meta.frontmatter_keys.description {
        if let Some(description) = meta.description.clone() {
            mapping.insert(
                serde_yml::Value::String("description".into()),
                serde_yml::Value::String(description),
            );
        }
    }
    if meta.frontmatter_keys.cover {
        if let Some(cover) = meta.cover.as_ref() {
            if let Ok(value) = serde_yml::to_value(cover) {
                mapping.insert(serde_yml::Value::String("cover".into()), value);
            }
        }
    }
    for (key, value) in &meta.extra {
        mapping.insert(serde_yml::Value::String(key.clone()), value.clone());
    }
    if mapping.is_empty() {
        String::new()
    } else {
        serde_yml::to_string(&mapping).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut meta = EntryMeta::new_persisted("Hello World");
        meta.description = Some("A short summary".into());
        meta.mark_description_present();
        meta.cover = Some(crate::files::entry::Cover::Color {
            value: crate::files::entry::ColorName::Blue,
        });
        meta.mark_cover_present();
        let body = "Some content here.\n";
        let raw = serialize(&meta, body);
        let (parsed_meta, parsed_body) = parse(&raw).unwrap();
        assert_eq!(parsed_meta.title, meta.title);
        assert_eq!(parsed_meta.description, meta.description);
        assert_eq!(parsed_meta.cover, meta.cover);
        assert_eq!(parsed_body, body);
        assert!(!raw.contains("\nid:"));
        assert!(!raw.contains("\ncreated:"));
        assert!(!raw.contains("\nupdated:"));
    }

    #[test]
    fn image_cover_roundtrip() {
        let raw = r#"---
title: With Cover
cover:
  type: image
  path: .assets/a1b2c3d4-cover.jpg
  position: 50
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
        let mut meta = EntryMeta::new_persisted("With Extra");
        meta.extra
            .insert("Статус".into(), serde_yml::Value::String("В работе".into()));

        let raw = serialize(&meta, "Body\n");
        let (parsed_meta, _) = parse(&raw).unwrap();

        assert!(!raw.contains("\nextra:"));
        assert_eq!(parsed_meta.extra.get("Статус"), meta.extra.get("Статус"));
    }

    #[test]
    fn entry_meta_json_serialization_nests_extra_fields() {
        let mut meta = EntryMeta::new_persisted("With Extra");
        meta.created = "2026-03-17T00:00:00Z".into();
        meta.updated = "2026-03-17T00:00:00Z".into();
        meta.extra
            .insert("Статус".into(), serde_yml::Value::String("В работе".into()));

        let json = serde_json::to_value(&meta).unwrap();

        assert_eq!(json["extra"]["Статус"], "В работе");
        assert!(json.get("Статус").is_none());
        assert!(json.get("id").is_none());
        assert_eq!(json["created"], "2026-03-17T00:00:00Z");
        assert_eq!(json["updated"], "2026-03-17T00:00:00Z");
    }

    #[test]
    fn title_only_frontmatter_is_valid() {
        let raw = "---\ntitle: Only Title\n---\nBody\n";
        let (meta, body) = parse(raw).unwrap();

        assert_eq!(meta.title, "Only Title");
        assert_eq!(body, "Body\n");
        assert!(meta.extra.is_empty());
    }

    #[test]
    fn legacy_system_keys_are_custom_extra_fields() {
        let raw = r#"---
title: Imported
id: old-id
created: 2026-01-01T00:00:00Z
updated: 2026-01-02T00:00:00Z
---
Body
"#;

        let (meta, _) = parse(raw).unwrap();

        assert_eq!(meta.title, "Imported");
        assert_eq!(
            meta.extra.get("id").and_then(serde_yml::Value::as_str),
            Some("old-id")
        );
        assert_eq!(
            meta.extra.get("created").and_then(serde_yml::Value::as_str),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(
            meta.extra.get("updated").and_then(serde_yml::Value::as_str),
            Some("2026-01-02T00:00:00Z")
        );

        let serialized = serialize(&meta, "Body\n");
        assert!(serialized.contains("\nid: old-id\n"));
        let (reserialized, _) = parse(&serialized).unwrap();
        assert_eq!(
            reserialized
                .extra
                .get("created")
                .and_then(serde_yml::Value::as_str),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(
            reserialized
                .extra
                .get("updated")
                .and_then(serde_yml::Value::as_str),
            Some("2026-01-02T00:00:00Z")
        );
    }

    #[test]
    fn malformed_frontmatter_status_preserves_raw_content_as_body() {
        let raw = "---\ntitle: [broken\n---\nBody\n";

        match parse_status(raw) {
            ParseStatus::Malformed { body, .. } => assert_eq!(body, raw),
            _ => panic!("expected malformed status"),
        }
    }

    #[test]
    fn replace_body_preserves_original_frontmatter_bytes() {
        let raw = "---\nid: old-id\ntitle: Old\n---\nOld body";
        let replaced = replace_body_preserving_frontmatter(raw, "New body").unwrap();

        assert_eq!(replaced, "---\nid: old-id\ntitle: Old\n---\nNew body");
    }
}
