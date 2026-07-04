use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::Value;

use super::{
    CandidateCwdSource, PersistedAgentSessionCandidate, SourceFingerprint, SourceInputFile,
    SourceScan, build_fingerprint, collect_optional_file, collect_recursive_dirs,
    collect_recursive_files, metadata_mtime, nested_string_field, read_jsonl, short_id,
    source_file_ref, string_field, timestamp_from_fields, title_from_text,
};
use crate::agent_sessions::types::{
    AgentSessionCounts, AgentSessionDiagnosticSeverity, AgentSessionSource,
    AgentSessionSourceReport, AgentSessionSourceStatus, AgentSessionTitleSource,
};

const SOURCE: AgentSessionSource = AgentSessionSource::Codex;

pub(crate) fn collect_fingerprint(root: &Path) -> (SourceFingerprint, AgentSessionSourceReport) {
    let mut report = AgentSessionSourceReport::new(SOURCE, root.to_string_lossy().into_owned());
    if !root.exists() {
        report.status = AgentSessionSourceStatus::MissingRoot;
        let fingerprint = SourceFingerprint {
            value: format!("missing-root:{}", root.to_string_lossy()),
        };
        report.fingerprint = Some(fingerprint.value.clone());
        return (fingerprint, report);
    }
    if !root.is_dir() {
        report.status = AgentSessionSourceStatus::Unreadable;
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Error,
            "source-root-not-directory",
            "source root is not a directory",
            Some(root.to_string_lossy().into_owned()),
            None,
        );
        let fingerprint = SourceFingerprint {
            value: format!("unreadable-root:{}", root.to_string_lossy()),
        };
        report.fingerprint = Some(fingerprint.value.clone());
        return (fingerprint, report);
    }

    let mut files = Vec::new();
    if let Some(file) = collect_optional_file(root, "history.jsonl", "history") {
        files.push(file);
    }
    if let Some(file) = collect_optional_file(root, "session_index.jsonl", "session-index") {
        files.push(file);
    }
    let sessions_root = root.join("sessions");
    if sessions_root.is_dir() {
        files.extend(collect_recursive_dirs(
            &sessions_root,
            "session-partition",
            3,
            &mut report,
        ));
    }

    let fingerprint = build_fingerprint(root, files, &mut report);
    report.fingerprint = Some(fingerprint.value.clone());
    (fingerprint, report)
}

pub(crate) fn scan(
    root: &Path,
    fingerprint: SourceFingerprint,
    mut report: AgentSessionSourceReport,
) -> SourceScan {
    if matches!(
        report.status,
        AgentSessionSourceStatus::MissingRoot | AgentSessionSourceStatus::Unreadable
    ) {
        return SourceScan {
            candidates: Vec::new(),
            report,
            fingerprint: fingerprint.value,
        };
    }

    let inputs = collect_scan_inputs(root, &mut report);
    report.counts.files_scanned = inputs.len();
    let mut builders: HashMap<String, SessionBuilder> = HashMap::new();
    for input in &inputs {
        match input.kind {
            "history" => parse_history(&input.path, &mut report, &mut builders),
            "session-index" => parse_session_index(&input.path, &mut report, &mut builders),
            "detail" => parse_detail(&input.path, &mut report, &mut builders),
            _ => {}
        }
    }

    let mut candidates = builders
        .into_values()
        .map(SessionBuilder::finish)
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| a.source_session_id.cmp(&b.source_session_id));
    report.counts.candidates = candidates.len();

    if report.counts.source_errors > 0 || report.counts.malformed_lines > 0 {
        report.mark_partial_if_ok();
    }

    if root.exists() && candidates.is_empty() && report.diagnostics.is_empty() {
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Info,
            "source-empty",
            "source root has no persisted sessions",
            Some(root.to_string_lossy().into_owned()),
            None,
        );
    }

    SourceScan {
        candidates,
        report,
        fingerprint: fingerprint.value,
    }
}

fn collect_scan_inputs(root: &Path, report: &mut AgentSessionSourceReport) -> Vec<SourceInputFile> {
    let mut files = Vec::new();
    if let Some(file) = collect_optional_file(root, "history.jsonl", "history") {
        files.push(file);
    }
    if let Some(file) = collect_optional_file(root, "session_index.jsonl", "session-index") {
        files.push(file);
    }
    let sessions_root = root.join("sessions");
    if sessions_root.is_dir() {
        files.extend(collect_recursive_files(
            &sessions_root,
            "detail",
            &|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            },
            report,
        ));
    }
    files
}

fn parse_history(
    path: &Path,
    report: &mut AgentSessionSourceReport,
    builders: &mut HashMap<String, SessionBuilder>,
) {
    let mtime = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata_mtime(&metadata));
    let mut pending_diagnostics = Vec::new();
    read_jsonl(path, report, |line, value| {
        let Some(id) = codex_history_id(&value) else {
            pending_diagnostics.push((
                "codex-history-missing-id",
                "codex history row has no session id",
                line,
            ));
            return;
        };
        let builder = builder_for(builders, id);
        builder.candidate.source_meta.history_present = true;
        builder.candidate.source_meta.history_line_count += 1;
        builder.set_source_file(source_file_ref(path, "history", Some(line)), 2);

        if let Some(title) = history_title(&value) {
            builder.set_title(title.0, title.1, 2);
        }
        if let Some(cwd) = string_field(&value, &["cwd"])
            .or_else(|| string_field(&value, &["project"]))
            .map(str::to_string)
        {
            builder.set_cwd(cwd, CandidateCwdSource::Cwd, 1);
        }
        if let Some(ts) = timestamp_from_fields(&value) {
            builder.observe_timestamp(ts, 1);
        } else if let Some(ts) = mtime {
            builder.observe_timestamp(ts, 2);
        }
    });
    for (code, message, line) in pending_diagnostics {
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Warning,
            code,
            message,
            Some(path.to_string_lossy().into_owned()),
            Some(line),
        );
    }
}

fn parse_session_index(
    path: &Path,
    report: &mut AgentSessionSourceReport,
    builders: &mut HashMap<String, SessionBuilder>,
) {
    let mut pending_diagnostics = Vec::new();
    let mut title_rows: HashMap<String, IndexTitleRow> = HashMap::new();
    let mut order = 0usize;
    read_jsonl(path, report, |line, value| {
        order += 1;
        let Some(id) = string_field(
            &value,
            &["sessionId", "session_id", "id", "sourceSessionId"],
        )
        .or_else(|| nested_string_field(&value, &["payload", "id"])) else {
            pending_diagnostics.push((
                "codex-session-index-missing-id",
                "codex session index row has no session id",
                line,
            ));
            return;
        };
        if let Some(title) = string_field(
            &value,
            &[
                "thread_name",
                "threadName",
                "title",
                "display",
                "displayText",
            ],
        )
        .and_then(title_from_text)
        {
            let id = id.to_string();
            let updated_at = value
                .get("updated_at")
                .and_then(super::parse_timestamp_value);
            let should_replace = title_rows.get(&id).is_none_or(|existing| {
                match (updated_at, existing.updated_at) {
                    (Some(next), Some(current)) => next > current,
                    (Some(_), None) => true,
                    (None, Some(_)) => false,
                    (None, None) => order > existing.order,
                }
            });
            if should_replace {
                title_rows.insert(
                    id,
                    IndexTitleRow {
                        title,
                        updated_at,
                        order,
                        line,
                    },
                );
            }
        }
    });
    for (id, row) in title_rows {
        let builder = builder_for(builders, id);
        builder.candidate.source_meta.session_index_present = true;
        builder.set_source_file(source_file_ref(path, "session-index", Some(row.line)), 1);
        builder.set_title(row.title, AgentSessionTitleSource::CliTitle, 0);
    }
    for (code, message, line) in pending_diagnostics {
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Warning,
            code,
            message,
            Some(path.to_string_lossy().into_owned()),
            Some(line),
        );
    }
}

fn parse_detail(
    path: &Path,
    report: &mut AgentSessionSourceReport,
    builders: &mut HashMap<String, SessionBuilder>,
) {
    let mut parsed = DetailParse::default();
    let (line_count, malformed_count) = read_jsonl(path, report, |line, value| {
        parsed.line_count += 1;
        parsed.observe_timestamp(timestamp_from_fields(&value));

        let event_type = string_field(&value, &["type"]).unwrap_or_default();
        if event_type == "session_meta" {
            if let Some(id) = nested_string_field(&value, &["payload", "id"]) {
                parsed.session_id = Some(id.to_string());
            }
            if let Some(cwd) = nested_string_field(&value, &["payload", "cwd"]) {
                parsed.cwd = Some(cwd.to_string());
            }
            return;
        }

        if event_type != "response_item" {
            return;
        }
        let Some(payload) = value.get("payload") else {
            return;
        };
        parsed.observe_timestamp(timestamp_from_fields(payload));
        if is_function_call(payload) {
            parsed.counts.function_calls += 1;
            parsed.function_call_count += 1;
        }

        match string_field(payload, &["role"]) {
            Some("user") => {
                parsed.counts.user_messages += 1;
                if parsed.first_prompt.is_none() {
                    parsed.first_prompt = extract_codex_user_text(payload);
                }
            }
            Some("assistant") => {
                parsed.counts.assistant_messages += 1;
            }
            _ => {}
        }

        if parsed.first_line.is_none() {
            parsed.first_line = Some(line);
        }
    });

    parsed.line_count = parsed.line_count.max(line_count);
    parsed.counts.malformed_lines += malformed_count;
    let file_mtime = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata_mtime(&metadata));
    let id = parsed
        .session_id
        .clone()
        .or_else(|| uuid_from_filename(path).inspect(|_| parsed.id_from_filename = true));

    let Some(id) = id else {
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Warning,
            "codex-detail-missing-id",
            "codex detail file has no session id",
            Some(path.to_string_lossy().into_owned()),
            None,
        );
        return;
    };

    let builder = builder_for(builders, id);
    builder.candidate.source_meta.detail_present = true;
    builder.candidate.source_meta.detail_file_count += 1;
    builder.candidate.source_meta.detail_line_count += parsed.line_count;
    builder.candidate.source_meta.malformed_line_count += malformed_count;
    builder.candidate.source_meta.function_call_count += parsed.function_call_count;
    builder.candidate.counts.user_messages += parsed.counts.user_messages;
    builder.candidate.counts.assistant_messages += parsed.counts.assistant_messages;
    builder.candidate.counts.function_calls += parsed.counts.function_calls;
    builder.candidate.counts.malformed_lines += parsed.counts.malformed_lines;
    builder.set_source_file(source_file_ref(path, "detail", parsed.first_line), 0);

    if let Some(title) = parsed.first_prompt {
        builder.set_title(title, AgentSessionTitleSource::FirstUserPrompt, 1);
    }
    if let Some(cwd) = parsed.cwd {
        builder.set_cwd(cwd, CandidateCwdSource::Cwd, 0);
    }
    if let Some(ts) = parsed.first_timestamp {
        builder.observe_created_timestamp(ts, 0);
    }
    if let Some(ts) = parsed.last_timestamp {
        builder.observe_last_timestamp(ts, 0);
    }
    if parsed.first_timestamp.is_none() && parsed.last_timestamp.is_none() {
        if let Some(ts) = file_mtime {
            builder.observe_timestamp(ts, 2);
        }
    }
    if parsed.id_from_filename {
        builder.add_note("id-from-filename");
    }
}

fn codex_history_id(value: &Value) -> Option<String> {
    string_field(
        value,
        &[
            "sessionId",
            "session_id",
            "id",
            "sourceSessionId",
            "conversationId",
            "conversation_id",
        ],
    )
    .or_else(|| nested_string_field(value, &["payload", "id"]))
    .map(str::to_string)
}

fn history_title(value: &Value) -> Option<(String, AgentSessionTitleSource)> {
    if let Some(title) =
        string_field(value, &["display", "displayText", "title"]).and_then(title_from_text)
    {
        return Some((title, AgentSessionTitleSource::CliTitle));
    }
    string_field(value, &["text", "prompt", "message"])
        .and_then(title_from_text)
        .map(|title| (title, AgentSessionTitleSource::FirstUserPrompt))
}

fn extract_codex_user_text(payload: &Value) -> Option<String> {
    if let Some(text) = string_field(payload, &["text", "prompt"]).and_then(title_from_text) {
        return Some(text);
    }
    if let Some(content) = payload.get("content") {
        if let Some(text) = content.as_str().and_then(title_from_text) {
            return Some(text);
        }
        if let Some(items) = content.as_array() {
            for item in items {
                if is_tool_or_function_payload(item) {
                    continue;
                }
                if let Some(text) =
                    string_field(item, &["text", "input_text"]).and_then(title_from_text)
                {
                    return Some(text);
                }
            }
        }
    }
    payload
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .and_then(title_from_text)
}

fn is_function_call(value: &Value) -> bool {
    string_field(value, &["type"]).is_some_and(|kind| kind == "function_call")
        || value.get("function_call").is_some()
}

fn is_tool_or_function_payload(value: &Value) -> bool {
    string_field(value, &["type"]).is_some_and(|kind| {
        kind.contains("tool") || kind.contains("function") || kind.contains("command")
    })
}

fn uuid_from_filename(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let regex =
        Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").ok()?;
    regex.find(name).map(|m| m.as_str().to_ascii_lowercase())
}

fn builder_for<'a>(
    builders: &'a mut HashMap<String, SessionBuilder>,
    id: String,
) -> &'a mut SessionBuilder {
    builders
        .entry(id.clone())
        .or_insert_with(|| SessionBuilder::new(SOURCE, id))
}

#[derive(Debug)]
struct IndexTitleRow {
    title: String,
    updated_at: Option<DateTime<Utc>>,
    order: usize,
    line: u64,
}

#[derive(Debug)]
struct SessionBuilder {
    candidate: PersistedAgentSessionCandidate,
    title_priority: u8,
    cwd_priority: u8,
    source_file_priority: u8,
    created_priority: Option<u8>,
    last_priority: Option<u8>,
}

impl SessionBuilder {
    fn new(source: AgentSessionSource, source_session_id: String) -> Self {
        Self {
            candidate: PersistedAgentSessionCandidate::new(source, source_session_id),
            title_priority: u8::MAX,
            cwd_priority: u8::MAX,
            source_file_priority: u8::MAX,
            created_priority: None,
            last_priority: None,
        }
    }

    fn set_title(&mut self, title: String, source: AgentSessionTitleSource, priority: u8) {
        if priority < self.title_priority {
            self.candidate.title = Some(title);
            self.candidate.title_source = source;
            self.title_priority = priority;
        }
    }

    fn set_cwd(&mut self, cwd: String, source: CandidateCwdSource, priority: u8) {
        if priority < self.cwd_priority {
            self.candidate.cwd = Some(cwd);
            self.candidate.cwd_source = source;
            self.cwd_priority = priority;
        }
    }

    fn set_source_file(
        &mut self,
        source_file: crate::agent_sessions::types::AgentSessionSourceFileRef,
        priority: u8,
    ) {
        if priority < self.source_file_priority {
            self.candidate.source_file = Some(source_file);
            self.source_file_priority = priority;
        }
    }

    fn observe_timestamp(&mut self, timestamp: DateTime<Utc>, priority: u8) {
        self.observe_created_timestamp(timestamp, priority);
        self.observe_last_timestamp(timestamp, priority);
    }

    fn observe_created_timestamp(&mut self, timestamp: DateTime<Utc>, priority: u8) {
        match self.created_priority {
            None => {
                self.candidate.created_at = Some(timestamp);
                self.created_priority = Some(priority);
            }
            Some(current) if priority < current => {
                self.candidate.created_at = Some(timestamp);
                self.created_priority = Some(priority);
            }
            Some(current) if priority == current => {
                if self
                    .candidate
                    .created_at
                    .is_none_or(|existing| timestamp < existing)
                {
                    self.candidate.created_at = Some(timestamp);
                }
            }
            _ => {}
        }
    }

    fn observe_last_timestamp(&mut self, timestamp: DateTime<Utc>, priority: u8) {
        match self.last_priority {
            None => {
                self.candidate.last_activity_at = Some(timestamp);
                self.last_priority = Some(priority);
            }
            Some(current) if priority < current => {
                self.candidate.last_activity_at = Some(timestamp);
                self.last_priority = Some(priority);
            }
            Some(current) if priority == current => {
                if self
                    .candidate
                    .last_activity_at
                    .is_none_or(|existing| timestamp > existing)
                {
                    self.candidate.last_activity_at = Some(timestamp);
                }
            }
            _ => {}
        }
    }

    fn add_note(&mut self, note: &str) {
        if !self
            .candidate
            .source_meta
            .notes
            .iter()
            .any(|existing| existing == note)
        {
            self.candidate.source_meta.notes.push(note.to_string());
        }
    }

    fn finish(mut self) -> PersistedAgentSessionCandidate {
        if self.candidate.title.is_none() {
            self.candidate.title = Some(short_id(&self.candidate.source_session_id));
            self.candidate.title_source = AgentSessionTitleSource::SessionId;
        }
        self.candidate
    }
}

#[derive(Debug, Default)]
struct DetailParse {
    session_id: Option<String>,
    cwd: Option<String>,
    first_prompt: Option<String>,
    first_timestamp: Option<DateTime<Utc>>,
    last_timestamp: Option<DateTime<Utc>>,
    counts: AgentSessionCounts,
    function_call_count: u32,
    line_count: u32,
    first_line: Option<u64>,
    id_from_filename: bool,
}

impl DetailParse {
    fn observe_timestamp(&mut self, timestamp: Option<DateTime<Utc>>) {
        let Some(timestamp) = timestamp else {
            return;
        };
        if self
            .first_timestamp
            .is_none_or(|current| timestamp < current)
        {
            self.first_timestamp = Some(timestamp);
        }
        if self
            .last_timestamp
            .is_none_or(|current| timestamp > current)
        {
            self.last_timestamp = Some(timestamp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, data: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, data).expect("write fixture");
    }

    fn scan_root(root: &Path) -> SourceScan {
        let (fingerprint, report) = collect_fingerprint(root);
        scan(root, fingerprint, report)
    }

    #[test]
    fn agent_sessions_codex_parser_merges_session_index_detail_history() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        write(
            &root.join("history.jsonl"),
            r#"{"sessionId":"codex-1","cwd":"/tmp/from-history","timestamp":1700000000,"text":"history prompt"}"#,
        );
        write(
            &root.join("session_index.jsonl"),
            r#"{"id":"codex-1","thread_name":"Index Title"}"#,
        );
        write(
            &root.join("sessions/2026/07/04/a/rollout-codex-1.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"codex-1","cwd":"/tmp/from-detail"},"timestamp":"2026-07-04T10:00:00Z"}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"detail prompt body"}]},"timestamp":"2026-07-04T10:01:00Z"}
{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"assistant body"}]},"timestamp":"2026-07-04T10:02:00Z"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let candidate = &scan.candidates[0];
        assert_eq!(candidate.source_session_id, "codex-1");
        assert_eq!(candidate.title.as_deref(), Some("Index Title"));
        assert_eq!(candidate.title_source, AgentSessionTitleSource::CliTitle);
        assert_eq!(candidate.cwd.as_deref(), Some("/tmp/from-detail"));
        assert_eq!(candidate.counts.user_messages, 1);
        assert_eq!(candidate.counts.assistant_messages, 1);
        assert_eq!(
            candidate
                .last_activity_at
                .expect("last activity")
                .to_rfc3339(),
            "2026-07-04T10:02:00+00:00"
        );
    }

    #[test]
    fn agent_sessions_codex_session_index_prefers_newer_updated_at() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        write(
            &root.join("session_index.jsonl"),
            r#"{"id":"codex-title","thread_name":"Older Title","updated_at":"2026-07-04T09:00:00Z"}
{"id":"codex-title","thread_name":"Newer Title","updated_at":"2026-07-04T10:00:00Z"}
{"id":"codex-title","thread_name":"No Timestamp Title"}"#,
        );
        write(
            &root.join("sessions/2026/07/04/a/rollout-codex-title.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"codex-title","cwd":"/tmp/project"},"timestamp":"2026-07-04T10:00:00Z"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.candidates[0].title.as_deref(), Some("Newer Title"));
    }

    #[test]
    fn agent_sessions_codex_parser_uses_fallbacks_and_malformed_diagnostic() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        write(
            &root.join("history.jsonl"),
            r#"{"sessionId":"codex-2","project":"/tmp/project","prompt":"history title","timestamp":"1700000000000"}
not-json"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let candidate = &scan.candidates[0];
        assert_eq!(candidate.title.as_deref(), Some("history title"));
        assert_eq!(candidate.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(
            candidate.last_activity_at.unwrap().timestamp(),
            1_700_000_000
        );
        assert_eq!(scan.report.counts.malformed_lines, 1);
        assert!(
            scan.report
                .diagnostics
                .iter()
                .any(|diag| diag.code == "jsonl-malformed")
        );
    }

    #[test]
    fn agent_sessions_codex_parser_uses_uuid_from_detail_filename() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        write(
            &root.join("sessions/2026/07/04/a/rollout-123e4567-e89b-12d3-a456-426614174000.jsonl"),
            r#"{"type":"response_item","payload":{"role":"user","content":"hello from detail"},"timestamp":"2026-07-04T10:01:00Z"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let candidate = &scan.candidates[0];
        assert_eq!(
            candidate.source_session_id,
            "123e4567-e89b-12d3-a456-426614174000"
        );
        assert_eq!(candidate.title.as_deref(), Some("hello from detail"));
        assert!(
            candidate
                .source_meta
                .notes
                .iter()
                .any(|note| note == "id-from-filename")
        );
    }
}
