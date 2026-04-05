use crate::error::AppError;
use crate::files::EntryMeta;

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

    let meta: EntryMeta = serde_yml::from_str(yaml_str).map_err(|e| {
        AppError::FrontmatterParse(format!("invalid YAML frontmatter: {e}"))
    })?;

    Ok((meta, body.to_string()))
}

/// Serialize frontmatter + body into a full markdown string.
pub fn serialize(meta: &EntryMeta, body: &str) -> String {
    let yaml = serde_yml::to_string(meta).unwrap_or_default();
    // serde_yml adds a trailing newline, so we don't need an extra one
    format!("---\n{yaml}---\n{body}")
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
            created: "2026-03-17T00:00:00Z".into(),
            updated: "2026-03-17T00:00:00Z".into(),
            extra: std::collections::HashMap::new(),
        };
        let body = "Some content here.\n";
        let raw = serialize(&meta, body);
        let (parsed_meta, parsed_body) = parse(&raw).unwrap();
        assert_eq!(parsed_meta.id, meta.id);
        assert_eq!(parsed_meta.title, meta.title);
        assert_eq!(parsed_body, body);
    }
}
