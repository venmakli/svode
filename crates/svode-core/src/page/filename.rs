use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_FILENAME_STEM_BYTES: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilenameProjectionReason {
    UnsafeCharacters,
    ReservedComponent,
    Truncated,
    Fallback,
}

impl FilenameProjectionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsafeCharacters => "unsafe_characters",
            Self::ReservedComponent => "reserved_component",
            Self::Truncated => "truncated",
            Self::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilenameProjection {
    pub stem: String,
    pub reasons: Vec<FilenameProjectionReason>,
}

impl FilenameProjection {
    pub fn is_lossy(&self) -> bool {
        !self.reasons.is_empty()
    }

    pub fn with_numeric_suffix(&self, suffix: usize) -> Self {
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

    pub fn reason_codes(&self) -> String {
        self.reasons
            .iter()
            .map(|reason| reason.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }
}

pub fn project(source: &str) -> FilenameProjection {
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
