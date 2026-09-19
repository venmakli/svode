//! Persisted Page frontmatter model, parser/serializer and field rules.

use std::collections::HashMap;
use std::path::Path;

use serde::{
    Deserialize,
    ser::{Serialize, SerializeStruct, Serializer},
};

use super::source::{
    ColorName, Cover, PageSource, PageSourceError, PageSourceMeta, ParsedMarkdown, parse_markdown,
    read_page_source, resolve_page_target,
};

#[derive(Debug, thiserror::Error)]
pub enum FrontmatterError {
    #[error("{0}")]
    Parse(String),
    #[error("invalid entry field: {0}")]
    InvalidField(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct FrontmatterKeys {
    pub title: bool,
    pub icon: bool,
    pub description: bool,
    pub cover: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EntryMeta {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    pub created: String,
    pub updated: String,
    /// User-defined custom fields from frontmatter YAML.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yml::Value>,
    #[serde(skip)]
    pub frontmatter_keys: FrontmatterKeys,
}

impl EntryMeta {
    pub fn from_source_meta(source: PageSourceMeta) -> Self {
        Self::from_frontmatter(
            source.title,
            source.icon,
            source.description,
            source.cover,
            source.extra,
            FrontmatterKeys {
                title: source.title_present,
                icon: source.icon_present,
                description: source.description_present,
                cover: source.cover_present,
            },
        )
    }

    /// Frontmatter model of a read source, including its runtime dates.
    pub fn from_page_source(source: &PageSource) -> Self {
        let mut meta = Self::from_source_meta(source.meta.clone());
        meta.created = source.created.clone();
        meta.updated = source.updated.clone();
        meta
    }

    pub fn new_persisted(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            icon: None,
            description: None,
            cover: None,
            created: String::new(),
            updated: String::new(),
            extra: HashMap::new(),
            frontmatter_keys: FrontmatterKeys {
                title: true,
                ..FrontmatterKeys::default()
            },
        }
    }

    pub fn synthesized(
        title: impl Into<String>,
        created: impl Into<String>,
        updated: impl Into<String>,
    ) -> Self {
        Self {
            title: title.into(),
            icon: None,
            description: None,
            cover: None,
            created: created.into(),
            updated: updated.into(),
            extra: HashMap::new(),
            frontmatter_keys: FrontmatterKeys::default(),
        }
    }

    pub fn from_frontmatter(
        title: String,
        icon: Option<String>,
        description: Option<String>,
        cover: Option<Cover>,
        extra: HashMap<String, serde_yml::Value>,
        frontmatter_keys: FrontmatterKeys,
    ) -> Self {
        Self {
            title,
            icon,
            description,
            cover,
            created: String::new(),
            updated: String::new(),
            extra,
            frontmatter_keys,
        }
    }

    pub fn mark_title_present(&mut self) {
        self.frontmatter_keys.title = true;
    }

    pub fn mark_icon_present(&mut self) {
        self.frontmatter_keys.icon = true;
    }

    pub fn mark_description_present(&mut self) {
        self.frontmatter_keys.description = true;
    }

    pub fn mark_cover_present(&mut self) {
        self.frontmatter_keys.cover = true;
    }
}

impl Serialize for EntryMeta {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("EntryMeta", 7)?;
        state.serialize_field("title", &self.title)?;
        state.serialize_field("icon", &self.icon)?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field("cover", &self.cover)?;
        state.serialize_field("created", &self.created)?;
        state.serialize_field("updated", &self.updated)?;
        state.serialize_field("extra", &self.extra)?;
        state.end()
    }
}

/// Reads the persisted frontmatter model of an existing Markdown source.
pub fn read_page_meta(space: &Path, path: &str) -> Result<EntryMeta, PageSourceError> {
    let target = resolve_page_target(space, path)?;
    let source = read_page_source(target)?;
    Ok(EntryMeta::from_page_source(&source))
}

/// Generate a title from a filename stem: "my-notes" → "My notes".
pub fn title_from_stem(stem: &str) -> String {
    let s = stem.replace('-', " ").replace('_', " ");
    let mut chars = s.chars();
    match chars.next() {
        None => "Untitled".to_string(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

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
pub fn try_parse(content: &str) -> Result<Option<(EntryMeta, String)>, FrontmatterError> {
    match parse_status(content) {
        ParseStatus::Missing { .. } => Ok(None),
        ParseStatus::Valid { meta, body } => Ok(Some((meta, body))),
        ParseStatus::Malformed { message, .. } => Err(FrontmatterError::Parse(message)),
    }
}

pub fn parse(content: &str) -> Result<(EntryMeta, String), FrontmatterError> {
    match parse_status(content) {
        ParseStatus::Valid { meta, body } => Ok((meta, body)),
        ParseStatus::Missing { .. } => Err(FrontmatterError::Parse(
            "file does not start with frontmatter delimiter '---'".into(),
        )),
        ParseStatus::Malformed { message, .. } => Err(FrontmatterError::Parse(message)),
    }
}

pub fn parse_status(content: &str) -> ParseStatus {
    match parse_markdown(content, "") {
        ParsedMarkdown::Missing(body) => ParseStatus::Missing { body },
        ParsedMarkdown::Valid(meta, body) => ParseStatus::Valid {
            meta: EntryMeta::from_source_meta(meta),
            body,
        },
        ParsedMarkdown::Malformed(message, body) => ParseStatus::Malformed { message, body },
    }
}

pub fn replace_body_preserving_frontmatter(
    content: &str,
    body: &str,
) -> Result<String, FrontmatterError> {
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

fn split_frontmatter(content: &str) -> Result<FrontmatterParts, FrontmatterError> {
    let leading_len = content.len() - content.trim_start().len();
    let trimmed = &content[leading_len..];
    if !trimmed.starts_with(FRONTMATTER_DELIMITER) {
        return Err(FrontmatterError::Parse(
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
            FrontmatterError::Parse("missing closing frontmatter delimiter '---'".into())
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

fn invalid_entry_field(message: impl Into<String>) -> FrontmatterError {
    FrontmatterError::InvalidField(message.into())
}

fn expect_string(value: serde_json::Value, field: &str) -> Result<String, FrontmatterError> {
    match value {
        serde_json::Value::String(s) => Ok(s),
        _ => Err(invalid_entry_field(format!("{field} must be a string"))),
    }
}

fn cover_from_json(value: serde_json::Value) -> Result<Cover, FrontmatterError> {
    let serde_json::Value::Object(mut object) = value else {
        return Err(invalid_entry_field("cover must be an object or null"));
    };

    let cover_type = object
        .remove("type")
        .and_then(|v| v.as_str().map(ToOwned::to_owned))
        .ok_or_else(|| invalid_entry_field("cover.type must be 'color' or 'image'"))?;

    match cover_type.as_str() {
        "color" => {
            let value = object
                .remove("value")
                .and_then(|v| v.as_str().map(ToOwned::to_owned))
                .ok_or_else(|| invalid_entry_field("cover.value must be a color name"))?;
            let value = ColorName::from_name(&value).ok_or_else(|| {
                invalid_entry_field(
                    "cover.value must be one of neutral, gray, red, orange, yellow, green, blue, purple, pink, brown",
                )
            })?;
            Ok(Cover::Color { value })
        }
        "image" => {
            let path = object
                .remove("path")
                .and_then(|v| v.as_str().map(ToOwned::to_owned))
                .ok_or_else(|| invalid_entry_field("cover.path must be a string"))?;
            let position = match object.remove("position") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::Number(n)) => {
                    let pos = n
                        .as_u64()
                        .ok_or_else(|| invalid_entry_field("cover.position must be 0..=100"))?;
                    if pos > 100 {
                        return Err(invalid_entry_field("cover.position must be 0..=100"));
                    }
                    Some(pos as u8)
                }
                Some(_) => return Err(invalid_entry_field("cover.position must be 0..=100")),
            };
            Ok(Cover::Image { path, position })
        }
        _ => Err(invalid_entry_field(
            "cover.type must be either 'color' or 'image'",
        )),
    }
}

/// Applies one system or custom frontmatter field value to the model.
pub fn apply_entry_field_update(
    meta: &mut EntryMeta,
    field: &str,
    value: serde_json::Value,
) -> Result<(), FrontmatterError> {
    match field {
        "created" | "updated" => Err(invalid_entry_field(format!("{field} is read-only"))),
        "title" => {
            meta.title = expect_string(value, "title")?;
            meta.mark_title_present();
            Ok(())
        }
        "icon" => {
            meta.icon = match value {
                serde_json::Value::Null => None,
                v => Some(expect_string(v, "icon")?),
            };
            if meta.icon.is_some() {
                meta.mark_icon_present();
            }
            Ok(())
        }
        "description" => {
            meta.description = match value {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) => {
                    if s.chars().count() > 500 {
                        return Err(invalid_entry_field(
                            "description must be at most 500 characters",
                        ));
                    }
                    if s.is_empty() { None } else { Some(s) }
                }
                _ => return Err(invalid_entry_field("description must be a string or null")),
            };
            if meta.description.is_some() {
                meta.mark_description_present();
            }
            Ok(())
        }
        "cover" => {
            meta.cover = match value {
                serde_json::Value::Null => None,
                v => Some(cover_from_json(v)?),
            };
            if meta.cover.is_some() {
                meta.mark_cover_present();
            }
            Ok(())
        }
        custom => {
            if value.is_null() {
                meta.extra.remove(custom);
            } else {
                let yaml_value = serde_yml::to_value(value)
                    .map_err(|e| invalid_entry_field(format!("{custom}: {e}")))?;
                meta.extra.insert(custom.to_string(), yaml_value);
            }
            Ok(())
        }
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
        meta.cover = Some(super::Cover::Color {
            value: super::ColorName::Blue,
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
            Some(super::Cover::Image {
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
