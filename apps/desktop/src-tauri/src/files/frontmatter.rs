use crate::error::AppError;
use crate::files::EntryMeta;

const FRONTMATTER_DELIMITER: &str = "---";

pub enum ParseStatus {
    Missing { body: String },
    Valid { meta: EntryMeta, body: String },
    Malformed { message: String, body: String },
}

struct FrontmatterParts {
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

#[cfg(test)]
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
    match svode_core::page::parse_markdown(content, "") {
        svode_core::page::ParsedMarkdown::Missing(body) => ParseStatus::Missing { body },
        svode_core::page::ParsedMarkdown::Valid(meta, body) => {
            match EntryMeta::from_source_meta(meta) {
                Ok(meta) => ParseStatus::Valid { meta, body },
                Err(error) => ParseStatus::Malformed {
                    message: error.to_string(),
                    body: content.to_string(),
                },
            }
        }
        svode_core::page::ParsedMarkdown::Malformed(message, body) => {
            ParseStatus::Malformed { message, body }
        }
    }
}

pub fn replace_body_preserving_frontmatter(content: &str, body: &str) -> Result<String, AppError> {
    let parts = split_frontmatter(content)?;
    let prefix = &content[..parts.body_start];
    let separator =
        if parts.body_start == content.len() && !prefix.ends_with('\n') && !body.is_empty() {
            "\n"
        } else {
            ""
        };
    Ok(format!("{prefix}{separator}{body}"))
}

fn split_frontmatter(content: &str) -> Result<FrontmatterParts, AppError> {
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

    let closing_start = yaml_start + end_pos + 1;
    let closing_end = closing_start + FRONTMATTER_DELIMITER.len();
    let body_start = if content[closing_end..].starts_with("\r\n") {
        closing_end + 2
    } else if content[closing_end..].starts_with('\n') {
        closing_end + 1
    } else {
        closing_end
    };

    Ok(FrontmatterParts { body_start })
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
    fn body_boundary_roundtrips_lf_crlf_and_eof() {
        let bodies = [
            "",
            "## Контекст\n",
            "Paragraph\n",
            "- Item\n",
            "```rust\nlet x = 1;\n```\n",
        ];
        for eol in ["\n", "\r\n"] {
            let metadata =
                format!("---{eol}title: 'Note'{eol}# Keep comment{eol}custom: [a, b]{eol}---");
            for closing_eol in ["", eol] {
                let prefix = format!("{metadata}{closing_eol}");
                assert_eq!(parse(&prefix).unwrap().1, "");
                for body in bodies {
                    let separator = if closing_eol.is_empty() && !body.is_empty() {
                        "\n"
                    } else {
                        ""
                    };
                    let expected = format!("{prefix}{separator}{body}");
                    let mut raw = prefix.clone();
                    for _ in 0..2 {
                        raw = replace_body_preserving_frontmatter(&raw, body).unwrap();
                        assert_eq!(raw, expected);
                        assert_eq!(parse(&raw).unwrap().1, body);
                    }
                }
            }
            let raw = format!("{metadata}{eol}{eol}## Old{eol}");
            assert_eq!(parse(&raw).unwrap().1, format!("{eol}## Old{eol}"));
            assert_eq!(
                replace_body_preserving_frontmatter(&raw, "").unwrap(),
                format!("{metadata}{eol}")
            );
        }
    }

    #[test]
    fn replace_body_preserves_original_frontmatter_bytes() {
        let raw = "---\nid: old-id\ntitle: Old\n---\nOld body";
        let replaced = replace_body_preserving_frontmatter(raw, "New body").unwrap();

        assert_eq!(replaced, "---\nid: old-id\ntitle: Old\n---\nNew body");
    }
}
