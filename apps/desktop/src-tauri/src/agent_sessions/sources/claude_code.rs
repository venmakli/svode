use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    CandidateCwdSource, PersistedAgentSessionCandidate, PersistedAgentSessionStatus,
    SourceFingerprint, SourceInputFile, SourceScan, build_fingerprint, collect_optional_file,
    collect_recursive_dirs, collect_recursive_files, metadata_mtime, nested_string_field,
    read_jsonl, short_id, source_file_ref, string_field, timestamp_from_fields, title_from_text,
    user_prompt_title_from_text,
};
use crate::agent_sessions::types::{
    AgentSessionCounts, AgentSessionDiagnosticSeverity, AgentSessionSource,
    AgentSessionSourceReport, AgentSessionSourceStatus, AgentSessionStatus,
    AgentSessionStatusConfidence, AgentSessionTitleSource,
};

const SOURCE: AgentSessionSource = AgentSessionSource::ClaudeCode;

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
    let projects_root = root.join("projects");
    if projects_root.is_dir() {
        files.extend(collect_recursive_dirs(
            &projects_root,
            "project-partition",
            1,
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
            "detail" => parse_detail(root, &input.path, &mut report, &mut builders),
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
    let projects_root = root.join("projects");
    if projects_root.is_dir() {
        files.extend(collect_recursive_files(
            &projects_root,
            "detail",
            &|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"),
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
        if !is_cli_entrypoint(&value) {
            pending_diagnostics.push((
                AgentSessionDiagnosticSeverity::Info,
                "claude-history-non-cli-entrypoint",
                "claude history row skipped because entrypoint is not cli",
                line,
            ));
            return;
        }

        let Some(id) = string_field(
            &value,
            &["sessionId", "session_id", "id", "sourceSessionId"],
        )
        .map(str::to_string) else {
            pending_diagnostics.push((
                AgentSessionDiagnosticSeverity::Warning,
                "claude-history-missing-id",
                "claude history row has no session id",
                line,
            ));
            return;
        };

        let builder = builder_for(builders, id);
        builder.candidate.source_meta.history_present = true;
        builder.candidate.source_meta.history_line_count += 1;
        builder.set_source_file(source_file_ref(path, "history", Some(line)), 2);
        if let Some(title) = string_field(&value, &["title", "summary"])
            .and_then(title_from_text)
            .or_else(|| {
                string_field(&value, &["display", "displayText"])
                    .and_then(user_prompt_title_from_text)
            })
        {
            builder.set_title(title, AgentSessionTitleSource::CliTitle, 1);
        }
        if let Some(project) = string_field(&value, &["project"]).map(str::to_string) {
            builder.set_cwd(project, CandidateCwdSource::Cwd, 2);
        }
        if let Some(ts) = timestamp_from_fields(&value) {
            builder.observe_timestamp(ts, 1);
        } else if let Some(ts) = mtime {
            builder.observe_timestamp(ts, 2);
        }
    });
    for (severity, code, message, line) in pending_diagnostics {
        report.push_diagnostic(
            severity,
            code,
            message,
            Some(path.to_string_lossy().into_owned()),
            Some(line),
        );
    }
}

fn parse_detail(
    root: &Path,
    path: &Path,
    report: &mut AgentSessionSourceReport,
    builders: &mut HashMap<String, SessionBuilder>,
) {
    let Some((_project_key, session_id)) = detail_file_parts(root, path) else {
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Warning,
            "claude-detail-path-unrecognized",
            "claude detail file is not under projects/<project>/<session>.jsonl",
            Some(path.to_string_lossy().into_owned()),
            None,
        );
        return;
    };

    let mut parsed = DetailParse::default();
    let (line_count, malformed_count) = read_jsonl(path, report, |line, value| {
        parsed.line_count += 1;
        parsed.observe_timestamp(timestamp_from_fields(&value));
        if !is_cli_entrypoint(&value) {
            parsed.non_cli_entrypoint = true;
            return;
        }
        parsed.tail.observe(&value);

        let line_type = string_field(&value, &["type"]).unwrap_or_default();
        match line_type {
            "custom-title" => {
                if let Some(title) = string_field(
                    &value,
                    &["customTitle", "custom_title", "title", "text", "name"],
                )
                .and_then(title_from_text)
                {
                    parsed.custom_title = Some(title);
                }
            }
            "worktree-state" => {
                if let Some(cwd) = nested_string_field(&value, &["worktreeSession", "originalCwd"])
                    .or_else(|| {
                        nested_string_field(
                            &value,
                            &["worktree-state", "worktreeSession", "originalCwd"],
                        )
                    })
                {
                    parsed.worktree_original_cwd = Some(cwd.to_string());
                }
            }
            _ => {}
        }

        let role = message_role(&value);
        if role == Some("user") {
            if !is_tool_result_line(&value) {
                parsed.counts.user_messages += 1;
                if parsed.first_user_cwd.is_none() {
                    parsed.first_user_cwd = string_field(&value, &["cwd"])
                        .or_else(|| nested_string_field(&value, &["message", "cwd"]))
                        .map(str::to_string);
                }
                if parsed.first_prompt.is_none() {
                    parsed.first_prompt = extract_claude_user_text(&value);
                }
            }
        } else if role == Some("assistant") {
            parsed.counts.assistant_messages += 1;
        }

        if parsed.first_line.is_none() {
            parsed.first_line = Some(line);
        }
    });

    parsed.line_count = parsed.line_count.max(line_count);
    parsed.counts.malformed_lines += malformed_count;
    if parsed.non_cli_entrypoint {
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Info,
            "claude-detail-non-cli-entrypoint",
            "claude detail file skipped because entrypoint is not cli",
            Some(path.to_string_lossy().into_owned()),
            None,
        );
        return;
    }

    let builder = builder_for(builders, session_id);
    builder.candidate.source_meta.detail_present = true;
    builder.candidate.source_meta.detail_file_count += 1;
    builder.candidate.source_meta.detail_line_count += parsed.line_count;
    builder.candidate.source_meta.malformed_line_count += malformed_count;
    builder.candidate.counts.user_messages += parsed.counts.user_messages;
    builder.candidate.counts.assistant_messages += parsed.counts.assistant_messages;
    builder.candidate.counts.malformed_lines += parsed.counts.malformed_lines;
    builder.set_source_file(source_file_ref(path, "detail", parsed.first_line), 0);

    if let Some(title) = parsed.custom_title {
        builder.set_title(title, AgentSessionTitleSource::CliTitle, 0);
    }
    if let Some(title) = parsed.first_prompt {
        builder.set_title(title, AgentSessionTitleSource::FirstUserPrompt, 2);
    }
    if let Some(cwd) = parsed.worktree_original_cwd {
        builder.set_cwd(cwd, CandidateCwdSource::WorktreeOriginal, 0);
    } else if let Some(cwd) = parsed.first_user_cwd {
        builder.set_cwd(cwd, CandidateCwdSource::Cwd, 1);
    }

    if let Some(ts) = parsed.first_timestamp {
        builder.observe_created_timestamp(ts, 0);
    }
    if let Some(ts) = parsed.last_timestamp {
        builder.observe_last_timestamp(ts, 0);
    }
    if parsed.first_timestamp.is_none() && parsed.last_timestamp.is_none() {
        if let Some(ts) = fs::metadata(path)
            .ok()
            .and_then(|metadata| metadata_mtime(&metadata))
        {
            builder.observe_timestamp(ts, 2);
        }
    }
    if let Some(status) = parsed.tail.finish() {
        builder.set_status(status);
    }
}

fn detail_file_parts(root: &Path, path: &Path) -> Option<(String, String)> {
    let rel = path.strip_prefix(root.join("projects")).ok()?;
    let mut components = rel.components();
    let project_key = components.next()?.as_os_str().to_string_lossy().to_string();
    let file = components.next()?.as_os_str().to_string_lossy().to_string();
    if components.next().is_some() || !file.ends_with(".jsonl") {
        return None;
    }
    Some((project_key, file.trim_end_matches(".jsonl").to_string()))
}

fn is_cli_entrypoint(value: &Value) -> bool {
    match string_field(value, &["entrypoint"]) {
        Some("cli") | None => true,
        Some(_) => false,
    }
}

fn message_role(value: &Value) -> Option<&str> {
    match string_field(value, &["type"]) {
        Some("user") => Some("user"),
        Some("assistant") => Some("assistant"),
        _ => nested_string_field(value, &["message", "role"]),
    }
}

fn is_tool_result_line(value: &Value) -> bool {
    if string_field(value, &["type"]).is_some_and(|kind| kind == "tool_result") {
        return true;
    }
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
    else {
        return false;
    };
    match content {
        Value::Array(items) => items
            .iter()
            .any(|item| string_field(item, &["type"]).is_some_and(|kind| kind == "tool_result")),
        _ => false,
    }
}

fn extract_claude_user_text(value: &Value) -> Option<String> {
    if is_tool_result_line(value) {
        return None;
    }
    let message = value.get("message").unwrap_or(value);
    if let Some(content) = message.get("content") {
        if let Some(text) = content.as_str().and_then(user_prompt_title_from_text) {
            return Some(text);
        }
        if let Some(items) = content.as_array() {
            for item in items {
                if string_field(item, &["type"]).is_some_and(|kind| kind != "text") {
                    continue;
                }
                if let Some(text) =
                    string_field(item, &["text"]).and_then(user_prompt_title_from_text)
                {
                    return Some(text);
                }
            }
        }
    }
    string_field(message, &["text", "prompt"]).and_then(user_prompt_title_from_text)
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

    fn set_status(&mut self, status: PersistedAgentSessionStatus) {
        let should_replace = self
            .candidate
            .status
            .as_ref()
            .and_then(|current| current.observed_at)
            .is_none_or(|current| status.observed_at.is_some_and(|next| next >= current));
        if should_replace {
            self.candidate.status = Some(status);
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
    custom_title: Option<String>,
    first_prompt: Option<String>,
    worktree_original_cwd: Option<String>,
    first_user_cwd: Option<String>,
    first_timestamp: Option<DateTime<Utc>>,
    last_timestamp: Option<DateTime<Utc>>,
    counts: AgentSessionCounts,
    line_count: u32,
    first_line: Option<u64>,
    non_cli_entrypoint: bool,
    tail: ClaudeTailState,
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

#[derive(Debug, Default)]
struct ClaudeTailState {
    status: Option<PersistedAgentSessionStatus>,
    open_tool_ids: Vec<String>,
}

impl ClaudeTailState {
    fn observe(&mut self, value: &Value) {
        let observed_at = timestamp_from_fields(value);
        match string_field(value, &["type"]) {
            Some("assistant") => self.observe_assistant(value, observed_at),
            Some("user") => self.observe_user(value, observed_at),
            Some("progress") => {
                if !self.open_tool_ids.is_empty() {
                    self.set_active(observed_at, "claude tool progress");
                }
            }
            Some("system") => {
                if matches!(
                    self.status.as_ref().map(|status| status.status),
                    Some(AgentSessionStatus::Done)
                ) {
                    return;
                }
                if !self.open_tool_ids.is_empty() {
                    self.set_active(observed_at, "claude task in progress");
                }
            }
            _ => {}
        }
    }

    fn finish(self) -> Option<PersistedAgentSessionStatus> {
        self.status
    }

    fn observe_assistant(&mut self, value: &Value, observed_at: Option<DateTime<Utc>>) {
        let tool_ids = assistant_tool_use_ids(value);
        if !tool_ids.is_empty() {
            self.open_tool_ids.extend(tool_ids);
            self.set_active(observed_at, "claude tool call in progress");
            return;
        }

        let stop_reason = nested_string_field(value, &["message", "stop_reason"]);
        if matches!(stop_reason, Some("end_turn" | "stop_sequence")) {
            self.open_tool_ids.clear();
            self.status = Some(PersistedAgentSessionStatus {
                status: AgentSessionStatus::Done,
                active_flags: Vec::new(),
                confidence: AgentSessionStatusConfidence::Strong,
                reason: "claude turn complete".to_string(),
                observed_at,
                waiting_since: None,
            });
            return;
        }

        if !self.open_tool_ids.is_empty() {
            self.set_active(observed_at, "claude task in progress");
        }
    }

    fn observe_user(&mut self, value: &Value, observed_at: Option<DateTime<Utc>>) {
        let result_ids = user_tool_result_ids(value);
        if !result_ids.is_empty() {
            self.open_tool_ids
                .retain(|id| !result_ids.iter().any(|result_id| result_id == id));
            self.set_active(observed_at, "claude tool result received");
            return;
        }

        self.open_tool_ids.clear();
        self.set_active(observed_at, "claude user prompt submitted");
    }

    fn set_active(&mut self, observed_at: Option<DateTime<Utc>>, reason: &str) {
        self.status = Some(PersistedAgentSessionStatus {
            status: AgentSessionStatus::Active,
            active_flags: Vec::new(),
            confidence: AgentSessionStatusConfidence::Strong,
            reason: reason.to_string(),
            observed_at,
            waiting_since: None,
        });
    }
}

fn assistant_tool_use_ids(value: &Value) -> Vec<String> {
    message_content_items(value)
        .into_iter()
        .filter(|item| string_field(item, &["type"]).is_some_and(|kind| kind == "tool_use"))
        .filter_map(|item| string_field(item, &["id"]).map(str::to_string))
        .collect()
}

fn user_tool_result_ids(value: &Value) -> Vec<String> {
    message_content_items(value)
        .into_iter()
        .filter(|item| string_field(item, &["type"]).is_some_and(|kind| kind == "tool_result"))
        .filter_map(|item| string_field(item, &["tool_use_id"]).map(str::to_string))
        .collect()
}

fn message_content_items(value: &Value) -> Vec<&Value> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
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
    fn agent_sessions_claude_parser_reads_history_skeleton() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("history.jsonl"),
            r#"{"sessionId":"claude-1","display":"History Title","project":"/tmp/project","timestamp":1700000000}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let candidate = &scan.candidates[0];
        assert_eq!(candidate.source_session_id, "claude-1");
        assert_eq!(candidate.title.as_deref(), Some("History Title"));
        assert_eq!(candidate.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(
            candidate.last_activity_at.unwrap().timestamp(),
            1_700_000_000
        );
    }

    #[test]
    fn agent_sessions_claude_parser_reads_detail_orphan_custom_title_and_worktree_cwd() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("projects/-tmp-project/claude-2.jsonl"),
            r#"{"type":"custom-title","title":"Custom Title","timestamp":"2026-07-04T09:00:00Z"}
{"type":"worktree-state","worktreeSession":{"originalCwd":"/tmp/project/worktree"},"timestamp":"2026-07-04T09:01:00Z"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first user prompt"}]},"cwd":"/tmp/project","timestamp":"2026-07-04T09:02:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"assistant body"}]},"timestamp":"2026-07-04T09:03:00Z"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let candidate = &scan.candidates[0];
        assert_eq!(candidate.source_session_id, "claude-2");
        assert_eq!(candidate.title.as_deref(), Some("Custom Title"));
        assert_eq!(candidate.cwd.as_deref(), Some("/tmp/project/worktree"));
        assert_eq!(candidate.cwd_source, CandidateCwdSource::WorktreeOriginal);
        assert_eq!(candidate.counts.user_messages, 1);
        assert_eq!(candidate.counts.assistant_messages, 1);
        assert_eq!(
            candidate
                .last_activity_at
                .expect("last activity")
                .to_rfc3339(),
            "2026-07-04T09:03:00+00:00"
        );
    }

    #[test]
    fn agent_sessions_claude_tail_tool_use_sets_active_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("projects/-tmp-project/claude-active.jsonl"),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"date"}}],"stop_reason":"tool_use"},"timestamp":"2026-07-04T09:00:00Z"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let status = scan.candidates[0].status.as_ref().expect("status");
        assert_eq!(status.status, AgentSessionStatus::Active);
        assert!(status.active_flags.is_empty());
        assert_eq!(status.reason, "claude tool call in progress");
    }

    #[test]
    fn agent_sessions_claude_tail_end_turn_sets_done_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("projects/-tmp-project/claude-done.jsonl"),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"},"timestamp":"2026-07-04T09:00:00Z"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        let status = scan.candidates[0].status.as_ref().expect("status");
        assert_eq!(status.status, AgentSessionStatus::Done);
        assert!(status.active_flags.is_empty());
        assert_eq!(status.reason, "claude turn complete");
    }

    #[test]
    fn agent_sessions_claude_parser_filters_explicit_non_cli_entrypoint() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("history.jsonl"),
            r#"{"sessionId":"claude-3","entrypoint":"ide","display":"IDE Session","project":"/tmp/project","timestamp":1700000000}"#,
        );
        write(
            &root.join("projects/-tmp-project/claude-4.jsonl"),
            r#"{"entrypoint":"web","type":"user","message":{"role":"user","content":"web prompt"},"timestamp":1700000000}"#,
        );

        let scan = scan_root(&root);
        assert!(scan.candidates.is_empty());
        assert!(
            scan.report
                .diagnostics
                .iter()
                .any(|diag| diag.code == "claude-history-non-cli-entrypoint")
        );
        assert!(
            scan.report
                .diagnostics
                .iter()
                .any(|diag| diag.code == "claude-detail-non-cli-entrypoint")
        );
    }

    #[test]
    fn agent_sessions_claude_parser_uses_file_mtime_timestamp_fallback() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("projects/-tmp-project/claude-5.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"prompt without timestamp"},"cwd":"/tmp/project"}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.candidates[0].last_activity_at.is_some());
    }

    #[test]
    fn agent_sessions_claude_parser_excludes_tool_result_from_first_prompt() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("projects/-tmp-project/claude-6.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"secret output"}]},"cwd":"/tmp/project","timestamp":1700000000}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"real prompt"}]},"cwd":"/tmp/project","timestamp":1700000001}"#,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates[0].title.as_deref(), Some("real prompt"));
    }

    #[test]
    fn agent_sessions_claude_parser_skips_context_wrapper_first_prompt() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        write(
            &root.join("projects/-tmp-project/claude-7.jsonl"),
            r##"{"type":"user","message":{"role":"user","content":"# CLAUDE.md instructions for /tmp/project\n\n<INSTRUCTIONS>ignore this</INSTRUCTIONS>"},"cwd":"/tmp/project","timestamp":1700000000}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"real claude prompt"}]},"cwd":"/tmp/project","timestamp":1700000001}"##,
        );

        let scan = scan_root(&root);
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(
            scan.candidates[0].title.as_deref(),
            Some("real claude prompt")
        );
        assert_eq!(
            scan.candidates[0].title_source,
            AgentSessionTitleSource::FirstUserPrompt
        );
    }
}
