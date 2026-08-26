use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::error::AppError;

pub(crate) const MAX_FILENAME_STEM_BYTES: usize = 60;

static MANAGED_NAMING_INTENTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FilenameProjectionReason {
    UnsafeCharacters,
    ReservedComponent,
    Truncated,
    Fallback,
}

impl FilenameProjectionReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::UnsafeCharacters => "unsafe_characters",
            Self::ReservedComponent => "reserved_component",
            Self::Truncated => "truncated",
            Self::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FilenameProjection {
    pub(crate) stem: String,
    pub(crate) reasons: Vec<FilenameProjectionReason>,
}

impl FilenameProjection {
    pub(crate) fn is_lossy(&self) -> bool {
        !self.reasons.is_empty()
    }

    pub(crate) fn with_numeric_suffix(&self, suffix: usize) -> Self {
        if suffix == 0 {
            return self.clone();
        }

        let suffix = format!("-{suffix}");
        let budget = MAX_FILENAME_STEM_BYTES.saturating_sub(suffix.len());
        let (base, truncated) = truncate_graphemes(&self.stem, budget);
        let base = base.trim_end_matches(['.', ' ']);
        let mut reasons = self.reasons.clone();
        if truncated || base.len() != self.stem.len() {
            push_reason(&mut reasons, FilenameProjectionReason::Truncated);
        }
        Self {
            stem: format!("{base}{suffix}"),
            reasons,
        }
    }

    pub(crate) fn reason_codes(&self) -> String {
        self.reasons
            .iter()
            .map(|reason| reason.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }
}

pub(crate) fn project(source: &str) -> FilenameProjection {
    let normalized = normalize_whitespace(source);
    let mut reasons = Vec::new();
    let mut sanitized = String::with_capacity(normalized.len());
    let mut in_unsafe_run = false;

    for character in normalized.chars() {
        if is_unsafe_character(character) {
            if !in_unsafe_run {
                sanitized.push('-');
                push_reason(&mut reasons, FilenameProjectionReason::UnsafeCharacters);
            }
            in_unsafe_run = true;
        } else {
            sanitized.push(character);
            in_unsafe_run = false;
        }
    }

    let before_component_trim = sanitized.clone();
    let sanitized = sanitized
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .to_string();
    if sanitized.len() != before_component_trim.len() {
        push_reason(&mut reasons, FilenameProjectionReason::UnsafeCharacters);
    }
    let mut stem = if sanitized.is_empty() {
        push_reason(&mut reasons, FilenameProjectionReason::Fallback);
        format!("untitled-{}", source_hash(&normalized))
    } else {
        sanitized
    };

    if is_windows_reserved_component(&stem) {
        stem.push_str("-file");
        push_reason(&mut reasons, FilenameProjectionReason::ReservedComponent);
    }

    let (truncated, was_truncated) = truncate_graphemes(&stem, MAX_FILENAME_STEM_BYTES);
    let mut truncated = truncated.trim_end_matches(['.', ' ']).to_string();
    if was_truncated || truncated.len() != stem.len() {
        push_reason(&mut reasons, FilenameProjectionReason::Truncated);
    }
    if truncated.is_empty() {
        truncated = format!("untitled-{}", source_hash(&normalized));
        push_reason(&mut reasons, FilenameProjectionReason::Fallback);
    }

    FilenameProjection {
        stem: truncated,
        reasons,
    }
}

pub(crate) fn allocate_available_path(
    parent: &Path,
    projection: &FilenameProjection,
    extension: Option<&str>,
) -> Result<(PathBuf, FilenameProjection), AppError> {
    for suffix in 0..=10_000 {
        let candidate = projection.with_numeric_suffix(suffix);
        let component = component_name(&candidate.stem, extension);
        if !component_conflicts_portably(parent, &component, None)? {
            return Ok((parent.join(component), candidate));
        }
    }
    Err(AppError::FileAlreadyExists(
        "could not allocate a portable filename".to_string(),
    ))
}

pub(crate) fn component_conflicts_portably(
    parent: &Path,
    candidate: &str,
    exclude_component: Option<&str>,
) -> Result<bool, AppError> {
    if !parent.is_dir() {
        return Ok(false);
    }
    let candidate_key = portable_component_key(candidate);
    for item in fs::read_dir(parent)? {
        let item = item?;
        let component = item.file_name().to_string_lossy().to_string();
        if exclude_component.is_some_and(|excluded| component == excluded) {
            continue;
        }
        if portable_component_key(&component) == candidate_key {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn component_name(stem: &str, extension: Option<&str>) -> String {
    match extension {
        Some(extension) => format!("{stem}.{extension}"),
        None => stem.to_string(),
    }
}

pub(crate) fn portable_component_key(value: &str) -> String {
    value.nfc().case_fold().nfc().collect()
}

pub(crate) fn mark_managed_naming_intent(space: &str, path: &str) {
    if let Ok(mut intents) = MANAGED_NAMING_INTENTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        intents.insert(naming_intent_key(space, path));
    }
}

pub(crate) fn has_managed_naming_intent(space: &str, path: &str) -> bool {
    MANAGED_NAMING_INTENTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .is_ok_and(|intents| intents.contains(&naming_intent_key(space, path)))
}

pub(crate) fn clear_managed_naming_intent(space: &str, path: &str) {
    if let Ok(mut intents) = MANAGED_NAMING_INTENTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        intents.remove(&naming_intent_key(space, path));
    }
}

fn naming_intent_key(space: &str, path: &str) -> String {
    format!(
        "{}\0{}",
        space.trim_end_matches(['/', '\\']),
        path.trim_matches(['/', '\\']).replace('\\', "/")
    )
}

fn normalize_whitespace(source: &str) -> String {
    let normalized: String = source.nfc().collect();
    let mut output = String::with_capacity(normalized.len());
    let mut pending_space = false;
    for character in normalized.chars() {
        if character.is_whitespace() {
            pending_space = !output.is_empty();
            continue;
        }
        if pending_space {
            output.push(' ');
            pending_space = false;
        }
        output.push(character);
    }
    output
}

fn is_unsafe_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\0' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '#'
        )
}

fn is_windows_reserved_component(stem: &str) -> bool {
    let device = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
    matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || device.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
}

fn source_hash(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    format!("{digest:x}")[..8].to_string()
}

fn truncate_graphemes(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut output = String::new();
    for grapheme in value.graphemes(true) {
        if output.len() + grapheme.len() > max_bytes {
            break;
        }
        output.push_str(grapheme);
    }
    (output, true)
}

fn push_reason(reasons: &mut Vec<FilenameProjectionReason>, reason: FilenameProjectionReason) {
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn projection_preserves_readable_unicode_case_spaces_and_emoji() {
        for value in [
            "Résumé Été",
            "Привет мир",
            "Καλημέρα κόσμε",
            "مرحبا بالعالم",
            "नमस्ते दुनिया",
            "你好 世界",
            "日本語 メモ",
            "한국어 메모",
            "Release 版本 🚀",
        ] {
            let projection = project(value);
            assert_eq!(projection.stem, value);
            assert!(projection.reasons.is_empty(), "{value:?}");
        }
    }

    #[test]
    fn projection_normalizes_nfc_and_unicode_whitespace() {
        assert_eq!(
            project("  Quarterly\tReview\u{2003}Q3  ").stem,
            "Quarterly Review Q3"
        );
        assert_eq!(project("Cafe\u{301}").stem, "Café");
        assert_eq!(project("Café").stem, project("Cafe\u{301}").stem);
    }

    #[test]
    fn projection_handles_unsafe_reserved_hidden_and_fallback_components() {
        let unsafe_projection = project("..Quarterly::<Review>#");
        assert_eq!(unsafe_projection.stem, "Quarterly-Review-");
        assert!(
            unsafe_projection
                .reasons
                .contains(&FilenameProjectionReason::UnsafeCharacters)
        );

        let reserved = project("CON.txt");
        assert_eq!(reserved.stem, "CON.txt-file");
        assert!(
            reserved
                .reasons
                .contains(&FilenameProjectionReason::ReservedComponent)
        );

        let hidden = project("...safe name. ");
        assert_eq!(hidden.stem, "safe name");

        let fallback = project("...");
        assert!(fallback.stem.starts_with("untitled-"));
        assert_eq!(fallback.stem.len(), "untitled-".len() + 8);
        assert!(
            fallback
                .reasons
                .contains(&FilenameProjectionReason::Fallback)
        );
        assert_eq!(fallback, project("..."));
    }

    #[test]
    fn projection_and_suffix_truncate_on_grapheme_boundaries_within_budget() {
        let projection = project(&"文".repeat(30));
        assert!(projection.stem.len() <= MAX_FILENAME_STEM_BYTES);
        assert!(
            projection
                .reasons
                .contains(&FilenameProjectionReason::Truncated)
        );
        assert!(projection.stem.is_char_boundary(projection.stem.len()));

        let emoji = project(&"👩🏽‍💻".repeat(10)).with_numeric_suffix(123);
        assert!(emoji.stem.len() <= MAX_FILENAME_STEM_BYTES);
        assert!(emoji.stem.ends_with("-123"));
        assert!(emoji.reasons.contains(&FilenameProjectionReason::Truncated));

        let oversized_grapheme = project(&format!("a{}", "\u{301}".repeat(100)));
        assert!(oversized_grapheme.stem.starts_with("untitled-"));
        assert!(
            oversized_grapheme
                .reasons
                .contains(&FilenameProjectionReason::Fallback)
        );
    }

    #[test]
    fn portable_allocation_treats_case_and_normalization_equivalents_as_occupied() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Café.md"), "").unwrap();
        fs::write(tmp.path().join("NAME.md"), "").unwrap();

        let (path, projection) =
            allocate_available_path(tmp.path(), &project("Cafe\u{301}"), Some("md")).unwrap();
        assert_eq!(path.file_name().unwrap().to_string_lossy(), "Café-1.md");
        assert_eq!(projection.stem, "Café-1");

        let (path, _) = allocate_available_path(tmp.path(), &project("name"), Some("md")).unwrap();
        assert_eq!(path.file_name().unwrap().to_string_lossy(), "name-1.md");
    }
}
