pub(crate) mod claude_code;
pub(crate) mod codex;

use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_sessions::types::{
    AgentSessionActiveFlag, AgentSessionCounts, AgentSessionDiagnosticSeverity, AgentSessionSource,
    AgentSessionSourceFileRef, AgentSessionSourceMeta, AgentSessionSourceReport,
    AgentSessionSourceStatus, AgentSessionStatus, AgentSessionStatusConfidence,
    AgentSessionTitleSource,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CandidateCwdSource {
    Cwd,
    WorktreeOriginal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedAgentSessionCandidate {
    pub source: AgentSessionSource,
    pub source_session_id: String,
    pub title: Option<String>,
    pub title_source: AgentSessionTitleSource,
    pub cwd: Option<String>,
    pub cwd_source: CandidateCwdSource,
    pub created_at: Option<DateTime<Utc>>,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub source_file: Option<AgentSessionSourceFileRef>,
    pub status: Option<PersistedAgentSessionStatus>,
    pub counts: AgentSessionCounts,
    pub source_meta: AgentSessionSourceMeta,
}

impl PersistedAgentSessionCandidate {
    pub(crate) fn new(source: AgentSessionSource, source_session_id: String) -> Self {
        Self {
            source,
            source_session_id,
            title: None,
            title_source: AgentSessionTitleSource::SessionId,
            cwd: None,
            cwd_source: CandidateCwdSource::Cwd,
            created_at: None,
            last_activity_at: None,
            source_file: None,
            status: None,
            counts: AgentSessionCounts::default(),
            source_meta: AgentSessionSourceMeta::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedAgentSessionStatus {
    pub status: AgentSessionStatus,
    pub active_flags: Vec<AgentSessionActiveFlag>,
    pub confidence: AgentSessionStatusConfidence,
    pub reason: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub waiting_since: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceInputFile {
    pub path: PathBuf,
    pub kind: &'static str,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceFingerprint {
    pub value: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceScan {
    pub candidates: Vec<PersistedAgentSessionCandidate>,
    pub report: AgentSessionSourceReport,
    pub fingerprint: String,
}

pub(crate) fn source_file_ref(
    path: &Path,
    _kind: &str,
    _line: Option<u64>,
) -> AgentSessionSourceFileRef {
    let metadata = fs::metadata(path).ok();
    AgentSessionSourceFileRef {
        path: path.to_string_lossy().into_owned(),
        mtime_ms: metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(system_time_millis)
            .unwrap_or(0),
        size_bytes: metadata.as_ref().map(Metadata::len).unwrap_or(0),
    }
}

pub(crate) fn short_id(source_session_id: &str) -> String {
    source_session_id.chars().take(8).collect()
}

pub(crate) fn title_from_text(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() || is_command_only_text(trimmed) {
        return None;
    }
    Some(trim_chars(trimmed, 80))
}

pub(crate) fn user_prompt_title_from_text(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() || is_command_only_text(trimmed) || is_context_wrapper_text(trimmed) {
        return None;
    }
    Some(trim_chars(trimmed, 80))
}

pub(crate) fn trim_chars(value: &str, max: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max {
            out.push_str("...");
            break;
        }
        out.push(ch);
    }
    out
}

pub(crate) fn is_command_only_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower == "exit"
        || lower == "quit"
        || lower == "/exit"
        || lower == "/quit"
        || lower.starts_with("<command-")
        || lower.starts_with("<local-command")
}

fn is_context_wrapper_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    if (starts_with_ascii_case_insensitive(trimmed, "# AGENTS.md instructions for ")
        || starts_with_ascii_case_insensitive(trimmed, "# CLAUDE.md instructions for "))
        && contains_ascii_case_insensitive(trimmed, "<INSTRUCTIONS>")
    {
        return true;
    }

    starts_with_ascii_case_insensitive(trimmed, "<environment_context>")
        || starts_with_ascii_case_insensitive(trimmed, "<system-reminder>")
        || starts_with_ascii_case_insensitive(trimmed, "<instructions>")
}

fn starts_with_ascii_case_insensitive(value: &str, prefix: &str) -> bool {
    let bytes = value.as_bytes();
    let prefix = prefix.as_bytes();
    bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn contains_ascii_case_insensitive(value: &str, needle: &str) -> bool {
    let needle = needle.as_bytes();
    if needle.is_empty() {
        return true;
    }
    value
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

pub(crate) fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    None
}

pub(crate) fn nested_string_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().filter(|s| !s.trim().is_empty())
}

pub(crate) fn parse_timestamp_value(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::String(s) => parse_timestamp_str(s),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                parse_epoch_number(i as f64)
            } else {
                n.as_f64().and_then(parse_epoch_number)
            }
        }
        _ => None,
    }
}

pub(crate) fn parse_timestamp_str(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(i) = trimmed.parse::<i64>() {
        return parse_epoch_number(i as f64);
    }
    if let Ok(f) = trimmed.parse::<f64>() {
        return parse_epoch_number(f);
    }
    DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn parse_epoch_number(value: f64) -> Option<DateTime<Utc>> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    if value >= 10_000_000_000.0 {
        let millis = value.round() as i64;
        Utc.timestamp_millis_opt(millis).single()
    } else {
        let seconds = value.trunc() as i64;
        let nanos = ((value.fract().abs()) * 1_000_000_000.0).round() as u32;
        Utc.timestamp_opt(seconds, nanos).single()
    }
}

pub(crate) fn timestamp_from_fields(value: &Value) -> Option<DateTime<Utc>> {
    for key in [
        "timestamp",
        "ts",
        "time",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "lastActivityAt",
    ] {
        if let Some(ts) = value.get(key).and_then(parse_timestamp_value) {
            return Some(ts);
        }
    }
    if let Some(payload) = value.get("payload") {
        for key in ["timestamp", "ts", "created_at", "createdAt"] {
            if let Some(ts) = payload.get(key).and_then(parse_timestamp_value) {
                return Some(ts);
            }
        }
    }
    None
}

pub(crate) fn metadata_mtime(metadata: &Metadata) -> Option<DateTime<Utc>> {
    metadata.modified().ok().map(DateTime::<Utc>::from)
}

fn metadata_fingerprint(metadata: &Metadata) -> String {
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{mtime_ms}:{}", metadata.len())
}

fn system_time_millis(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis())
}

pub(crate) fn build_fingerprint(
    root: &Path,
    files: Vec<SourceInputFile>,
    report: &mut AgentSessionSourceReport,
) -> SourceFingerprint {
    let mut parts = Vec::new();
    match fs::metadata(root) {
        Ok(metadata) => parts.push(format!(".root:{}", metadata_fingerprint(&metadata))),
        Err(error) => {
            report.status = AgentSessionSourceStatus::Unreadable;
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Error,
                "source-root-metadata",
                format!("source root metadata unavailable: {error}"),
                Some(root.to_string_lossy().into_owned()),
                None,
            );
        }
    }

    let mut sorted = files;
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    for input in &sorted {
        match fs::metadata(&input.path) {
            Ok(metadata) => {
                parts.push(format!(
                    "{}:{}:{}",
                    input.kind,
                    input.path.to_string_lossy(),
                    metadata_fingerprint(&metadata)
                ));
            }
            Err(error) => {
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Error,
                    "source-file-metadata",
                    format!("source file metadata unavailable: {error}"),
                    Some(input.path.to_string_lossy().into_owned()),
                    None,
                );
            }
        }
    }

    SourceFingerprint {
        value: parts.join("|"),
    }
}

pub(crate) fn collect_optional_file(
    root: &Path,
    relative: &str,
    kind: &'static str,
) -> Option<SourceInputFile> {
    let path = root.join(relative);
    if path.is_file() {
        Some(SourceInputFile { path, kind })
    } else {
        None
    }
}

pub(crate) fn collect_recursive_files(
    root: &Path,
    kind: &'static str,
    accept: &dyn Fn(&Path) -> bool,
    report: &mut AgentSessionSourceReport,
) -> Vec<SourceInputFile> {
    let mut files = Vec::new();
    collect_recursive_files_inner(root, kind, accept, report, &mut files);
    files
}

pub(crate) fn collect_recursive_dirs(
    root: &Path,
    kind: &'static str,
    max_depth: usize,
    report: &mut AgentSessionSourceReport,
) -> Vec<SourceInputFile> {
    let mut dirs = Vec::new();
    collect_recursive_dirs_inner(root, kind, max_depth, 0, report, &mut dirs);
    dirs
}

fn collect_recursive_files_inner(
    dir: &Path,
    kind: &'static str,
    accept: &dyn Fn(&Path) -> bool,
    report: &mut AgentSessionSourceReport,
    files: &mut Vec<SourceInputFile>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            if dir == Path::new(&report.root_path) {
                report.status = AgentSessionSourceStatus::Unreadable;
            } else {
                report.mark_partial_if_ok();
            }
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Error,
                "source-read-dir",
                format!("source directory unreadable: {error}"),
                Some(dir.to_string_lossy().into_owned()),
                None,
            );
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Error,
                    "source-dir-entry",
                    format!("source directory entry unreadable: {error}"),
                    Some(dir.to_string_lossy().into_owned()),
                    None,
                );
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Error,
                    "source-entry-type",
                    format!("source entry type unavailable: {error}"),
                    Some(path.to_string_lossy().into_owned()),
                    None,
                );
                continue;
            }
        };
        if file_type.is_dir() {
            collect_recursive_files_inner(&path, kind, accept, report, files);
        } else if file_type.is_file() && accept(&path) {
            files.push(SourceInputFile { path, kind });
        }
    }
}

fn collect_recursive_dirs_inner(
    dir: &Path,
    kind: &'static str,
    max_depth: usize,
    depth: usize,
    report: &mut AgentSessionSourceReport,
    dirs: &mut Vec<SourceInputFile>,
) {
    dirs.push(SourceInputFile {
        path: dir.to_path_buf(),
        kind,
    });
    if depth >= max_depth {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            if dir == Path::new(&report.root_path) {
                report.status = AgentSessionSourceStatus::Unreadable;
            } else {
                report.mark_partial_if_ok();
            }
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Error,
                "source-read-dir",
                format!("source directory unreadable: {error}"),
                Some(dir.to_string_lossy().into_owned()),
                None,
            );
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Error,
                    "source-dir-entry",
                    format!("source directory entry unreadable: {error}"),
                    Some(dir.to_string_lossy().into_owned()),
                    None,
                );
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Error,
                    "source-entry-type",
                    format!("source entry type unavailable: {error}"),
                    Some(path.to_string_lossy().into_owned()),
                    None,
                );
                continue;
            }
        };
        if file_type.is_dir() {
            collect_recursive_dirs_inner(&path, kind, max_depth, depth + 1, report, dirs);
        }
    }
}

pub(crate) fn read_jsonl<F>(
    path: &Path,
    report: &mut AgentSessionSourceReport,
    mut handle: F,
) -> (u32, u32)
where
    F: FnMut(u64, Value),
{
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            report.mark_partial_if_ok();
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Error,
                "source-file-open",
                format!("source file unreadable: {error}"),
                Some(path.to_string_lossy().into_owned()),
                None,
            );
            return (0, 0);
        }
    };

    let mut line_count = 0u32;
    let mut malformed_count = 0u32;
    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line_no = idx as u64 + 1;
        line_count += 1;
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                malformed_count += 1;
                report.counts.malformed_lines += 1;
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Warning,
                    "jsonl-line-read",
                    format!("jsonl line unreadable: {error}"),
                    Some(path.to_string_lossy().into_owned()),
                    Some(line_no),
                );
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => handle(line_no, value),
            Err(error) => {
                malformed_count += 1;
                report.counts.malformed_lines += 1;
                report.mark_partial_if_ok();
                report.push_diagnostic(
                    AgentSessionDiagnosticSeverity::Warning,
                    "jsonl-malformed",
                    format!("jsonl line malformed: {error}"),
                    Some(path.to_string_lossy().into_owned()),
                    Some(line_no),
                );
            }
        }
    }
    report.counts.records_read += line_count as usize;
    (line_count, malformed_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_sessions_timestamp_parser_rejects_invalid_and_zero() {
        assert!(parse_timestamp_value(&json!(0)).is_none());
        assert!(parse_timestamp_value(&json!("0")).is_none());
        assert!(parse_timestamp_value(&json!("not a timestamp")).is_none());
    }

    #[test]
    fn agent_sessions_timestamp_parser_accepts_seconds_and_milliseconds() {
        let seconds = parse_timestamp_value(&json!(1_700_000_000)).expect("seconds timestamp");
        let millis = parse_timestamp_value(&json!(1_700_000_000_000i64)).expect("millis timestamp");

        assert_eq!(seconds.timestamp(), 1_700_000_000);
        assert_eq!(millis.timestamp(), 1_700_000_000);
    }

    #[test]
    fn agent_sessions_timestamp_parser_accepts_iso() {
        let parsed = parse_timestamp_value(&json!("2026-07-04T10:11:12Z")).expect("iso timestamp");
        assert_eq!(parsed.to_rfc3339(), "2026-07-04T10:11:12+00:00");
    }

    #[test]
    fn agent_sessions_prompt_title_rejects_context_wrappers() {
        assert_eq!(
            user_prompt_title_from_text(
                "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>noise</INSTRUCTIONS>"
            ),
            None
        );
        assert_eq!(
            user_prompt_title_from_text("<environment_context><cwd>/tmp/project</cwd>"),
            None
        );
        assert_eq!(
            user_prompt_title_from_text("fix session title"),
            Some("fix session title".to_string())
        );
    }
}
