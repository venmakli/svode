//! Media in agent output (Stage 10 `08` R1): the content blocks any agent
//! may send, the media each built-in agent sends outside them, and the
//! inline data the runtime never keeps as text.

use std::path::Path;

use serde_json::Value;
use svode_core::agent_adapters::{AgentAdapterKind, system_home_dir};
use svode_core::system_path;

use super::normalize::{URI_LIMIT, bounded, content_text};
use crate::activity::{DetailBlock, MediaKind};

/// Base64 runs and data URLs longer than this become a size mark in text.
pub(crate) const INLINE_DATA_LIMIT: usize = 1024;
const NAME_LIMIT: usize = 255;
const MIME_LIMIT: usize = 128;

/// A media segment as the agent sent it, before the projection numbers it
/// and holds its data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaPart {
    pub kind: MediaKind,
    pub name: Option<String>,
    pub mime_type: Option<String>,
    pub path: Option<String>,
    pub size: Option<u64>,
    /// Base64. Never set beside a path the data is the file of.
    pub data: Option<String>,
    /// Media of an MCP call result, kept only in a call recognized as one.
    pub mcp_only: bool,
}

impl MediaPart {
    fn new(
        fallback: MediaKind,
        mime_type: Option<&str>,
        path: Option<String>,
        name: Option<&str>,
        size: Option<u64>,
        data: Option<String>,
    ) -> Self {
        let mime_type = mime_type
            .map(str::trim)
            .filter(|mime| !mime.is_empty())
            .map(|mime| bounded(mime, MIME_LIMIT));
        // `codex-acp` names a link by its whole path.
        let name = name
            .filter(|name| !name.trim().is_empty())
            .and_then(|name| match Path::new(name).is_absolute() {
                true => file_name(name),
                false => Some(bounded(name, NAME_LIMIT)),
            })
            .or_else(|| path.as_deref().and_then(file_name));
        let kind = mime_type
            .as_deref()
            .and_then(mime_kind)
            .or_else(|| path.as_deref().and_then(extension_kind))
            .or_else(|| name.as_deref().and_then(extension_kind))
            .unwrap_or(fallback);
        let data = data.filter(|data| !data.is_empty());
        let size = size.or_else(|| data.as_deref().map(decoded_size));
        Self {
            kind,
            name,
            mime_type,
            size,
            // The file is the source; its copy in the message is not kept.
            data: data.filter(|_| path.is_none()),
            path,
            mcp_only: false,
        }
    }

    /// `path` is the file of this media: it names the segment and replaces
    /// its data.
    fn set_file(&mut self, path: String) {
        if self.name.is_none() {
            self.name = file_name(&path);
        }
        self.path = Some(path);
        self.data = None;
    }
}

/// The media part of an ACP content block: `image`, `audio`,
/// `resource_link`, or `resource` with a blob. None for text and for a
/// link or resource that is not a local file.
pub(crate) fn block_media(block: &Value) -> Option<MediaPart> {
    let field = |key: &str| block.get(key).and_then(Value::as_str);
    let fallback = match field("type")? {
        "image" => MediaKind::Image,
        "audio" => MediaKind::Audio,
        "resource_link" => {
            let path = local_path(field("uri")?)?;
            return Some(MediaPart::new(
                MediaKind::File,
                field("mimeType"),
                Some(path),
                field("name"),
                block.get("size").and_then(Value::as_u64),
                None,
            ));
        }
        "resource" => {
            let resource = block.get("resource")?;
            let blob = resource.get("blob").and_then(Value::as_str)?;
            let path = resource
                .get("uri")
                .and_then(Value::as_str)
                .and_then(local_path);
            return Some(MediaPart::new(
                MediaKind::File,
                resource.get("mimeType").and_then(Value::as_str),
                path,
                None,
                None,
                Some(blob.to_string()),
            ));
        }
        _ => return None,
    };
    let path = field("uri").and_then(local_path);
    let data = field("data").map(str::to_string);
    if path.is_none() && data.is_none() {
        return None;
    }
    Some(MediaPart::new(
        fallback,
        field("mimeType"),
        path,
        None,
        None,
        data,
    ))
}

/// Text of a content block that is not media; an embedded text resource is
/// its text (C4).
fn block_text(block: &Value) -> String {
    match block
        .get("resource")
        .filter(|_| block.get("type").and_then(Value::as_str) == Some("resource"))
        .and_then(|resource| resource.get("text"))
        .and_then(Value::as_str)
    {
        Some(text) => text.to_string(),
        None => content_text(block),
    }
}

/// A chunk of an agent message: its text and its media.
pub(crate) fn message_content(block: &Value) -> (String, Vec<MediaPart>) {
    match block_media(block) {
        Some(part) => (String::new(), vec![part]),
        None => (block_text(block), Vec::new()),
    }
}

/// Text blocks and media of a tool call's content and raw output.
pub(crate) struct ToolOutput {
    pub blocks: Vec<DetailBlock>,
    pub media: Vec<MediaPart>,
}

enum Entry {
    Text(String),
    Media(MediaPart),
    Block(DetailBlock),
}

pub(crate) fn tool_output(
    agent: Option<AgentAdapterKind>,
    content: &[Value],
    raw_output: Option<&Value>,
) -> ToolOutput {
    let mut entries = Vec::new();
    for item in content {
        let entry = match item.get("type").and_then(Value::as_str) {
            Some("content") => item.get("content").map(|block| match block_media(block) {
                Some(part) => Entry::Media(part),
                None => Entry::Text(block_text(block)),
            }),
            Some("diff") => diff(item).map(Entry::Block),
            Some("terminal") => item
                .get("terminalId")
                .and_then(Value::as_str)
                .map(|terminal_id| {
                    Entry::Block(DetailBlock::Terminal {
                        terminal_id: terminal_id.to_string(),
                    })
                }),
            _ => None,
        };
        entries.extend(entry);
    }
    let had_content = !entries.is_empty();
    let mut outside = Vec::new();
    match agent {
        Some(AgentAdapterKind::ClaudeCode) => claude_markers(&mut entries),
        Some(AgentAdapterKind::Hermes) => hermes_media(&mut entries),
        Some(AgentAdapterKind::KimiCode) => kimi_media(&mut entries, raw_output, &mut outside),
        Some(AgentAdapterKind::Pi) => outside.extend(raw_blocks(
            raw_output.and_then(|output| output.get("content")),
        )),
        Some(AgentAdapterKind::Codex) => outside.extend(
            raw_blocks(
                raw_output
                    .and_then(|output| output.get("result"))
                    .and_then(|result| result.get("content")),
            )
            .map(|part| MediaPart {
                mcp_only: true,
                ..part
            }),
        ),
        _ => {}
    }
    let mut blocks = Vec::new();
    let mut media = Vec::new();
    for entry in entries {
        match entry {
            Entry::Text(text) => blocks.push(DetailBlock::Text {
                text: scrub_inline_data(&text),
            }),
            Entry::Media(part) => media.push(part),
            Entry::Block(block) => blocks.push(block),
        }
    }
    media.extend(outside);
    if !had_content && let Some(output) = raw_output {
        blocks.push(DetailBlock::Text {
            text: scrub_inline_data(&match output {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            }),
        });
    }
    ToolOutput {
        blocks,
        media: one_copy(media),
    }
}

fn diff(item: &Value) -> Option<DetailBlock> {
    Some(DetailBlock::Diff {
        path: item.get("path")?.as_str()?.to_string(),
        old_text: item
            .get("oldText")
            .and_then(Value::as_str)
            .map(str::to_string),
        new_text: item.get("newText")?.as_str()?.to_string(),
    })
}

/// `image` and `audio` blocks of an MCP-shaped content array an agent puts
/// into its raw output.
fn raw_blocks(blocks: Option<&Value>) -> impl Iterator<Item = MediaPart> + '_ {
    blocks
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("image" | "audio")
            )
        })
        .filter_map(block_media)
}

/// The same data or file in several places of one item is one segment;
/// a part with neither is dropped.
fn one_copy(parts: Vec<MediaPart>) -> Vec<MediaPart> {
    let mut kept: Vec<MediaPart> = Vec::with_capacity(parts.len());
    for part in parts {
        if part.data.is_none() && part.path.is_none() {
            continue;
        }
        let known = kept.iter().any(|known| {
            (part.data.is_some() && known.data == part.data)
                || (part.path.is_some() && known.path == part.path)
        });
        if !known {
            kept.push(part);
        }
    }
    kept
}

/// Claude Code: `[Image: source: <path>]` is the file of the image block
/// before it, `[Audio from <server>] … saved to <path>` an audio file.
fn claude_markers(entries: &mut Vec<Entry>) {
    let mut kept: Vec<Entry> = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let Entry::Text(text) = &entry else {
            kept.push(entry);
            continue;
        };
        let text = text.trim();
        if let Some(path) = text
            .strip_prefix("[Image: source: ")
            .and_then(|rest| rest.strip_suffix(']'))
            .and_then(|path| local_path(path.trim()))
        {
            let image = kept.iter_mut().rev().find_map(|entry| match entry {
                Entry::Media(part) if part.kind == MediaKind::Image && part.path.is_none() => {
                    Some(part)
                }
                _ => None,
            });
            match image {
                Some(image) => image.set_file(path),
                None => kept.push(Entry::Media(MediaPart::new(
                    MediaKind::Image,
                    None,
                    Some(path),
                    None,
                    None,
                    None,
                ))),
            }
            continue;
        }
        if let Some(rest) = text.strip_prefix("[Audio from ")
            && let Some((_, saved)) = rest.rsplit_once(" saved to ")
            && let Some(path) = local_path(saved.trim())
        {
            let mime = rest
                .split_once("Binary content (")
                .and_then(|(_, details)| details.split([',', ')']).next());
            kept.push(Entry::Media(MediaPart::new(
                MediaKind::Audio,
                mime,
                Some(path),
                None,
                None,
                None,
            )));
            continue;
        }
        kept.push(entry);
    }
    *entries = kept;
}

/// Hermes: `MEDIA:<path>` lines of a tool result are media after its text.
fn hermes_media(entries: &mut Vec<Entry>) {
    let mut kept = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let Entry::Text(text) = &entry else {
            kept.push(entry);
            continue;
        };
        let (rest, paths) = media_lines(text);
        if paths.is_empty() {
            kept.push(entry);
            continue;
        }
        if !rest.trim().is_empty() {
            kept.push(Entry::Text(rest));
        }
        kept.extend(paths.into_iter().map(|path| {
            Entry::Media(MediaPart::new(
                MediaKind::File,
                None,
                Some(path),
                None,
                None,
                None,
            ))
        }));
    }
    *entries = kept;
}

/// Kimi Code: `image_url` and `audio_url` parts with data URLs in the raw
/// output and in the JSON text of the content (live); in replay the data is
/// gone and `[image_url]`, `[audio_url]` take the file from `<image
/// path="…">` or `Original attachment saved at: "<path>"`.
fn kimi_media(entries: &mut Vec<Entry>, raw_output: Option<&Value>, outside: &mut Vec<MediaPart>) {
    if let Some(Value::Array(parts)) = raw_output {
        outside.extend(parts.iter().filter_map(kimi_part));
    }
    let mut image_path = None;
    let mut saved = Vec::new();
    let mut kept = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let Entry::Text(text) = &entry else {
            kept.push(entry);
            continue;
        };
        let trimmed = text.trim();
        if trimmed.starts_with('[')
            && let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(trimmed)
        {
            outside.extend(parts.iter().filter_map(kimi_part));
            kept.push(entry);
            continue;
        }
        let placeholder = match trimmed {
            "[image_url]" => Some(MediaKind::Image),
            "[audio_url]" => Some(MediaKind::Audio),
            _ => None,
        };
        if let Some(kind) = placeholder {
            kept.push(Entry::Media(MediaPart::new(
                kind, None, None, None, None, None,
            )));
            continue;
        }
        if trimmed == "</image>" {
            continue;
        }
        if let Some(path) = trimmed
            .strip_prefix("<image path=\"")
            .and_then(|rest| rest.strip_suffix("\">"))
        {
            image_path = local_path(path);
            continue;
        }
        let (rest, paths) = attachment_paths(text);
        if paths.is_empty() {
            kept.push(entry);
            continue;
        }
        saved.extend(paths);
        if !rest.trim().is_empty() {
            kept.push(Entry::Text(rest));
        }
    }
    for entry in &mut kept {
        let Entry::Media(part) = entry else {
            continue;
        };
        if part.data.is_some() || part.path.is_some() {
            continue;
        }
        let path = match (part.kind, image_path.is_some()) {
            (MediaKind::Image, true) => image_path.take(),
            _ => saved
                .iter()
                .position(|path| extension_kind(path) == Some(part.kind))
                .map(|index| saved.remove(index)),
        };
        if let Some(path) = path {
            *part = MediaPart::new(part.kind, None, Some(path), None, None, None);
        }
    }
    *entries = kept;
}

fn kimi_part(part: &Value) -> Option<MediaPart> {
    let (kind, keys) = match part.get("type").and_then(Value::as_str)? {
        "image_url" => (MediaKind::Image, ["imageUrl", "image_url"]),
        "audio_url" => (MediaKind::Audio, ["audioUrl", "audio_url"]),
        _ => return None,
    };
    let url = keys
        .iter()
        .find_map(|key| part.get(*key))
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)?;
    let (mime, data) = data_url(url)?;
    Some(MediaPart::new(
        kind,
        Some(mime),
        None,
        None,
        None,
        Some(data.to_string()),
    ))
}

/// Lines `Original attachment saved at: "<path>"` taken out of `text`.
fn attachment_paths(text: &str) -> (String, Vec<String>) {
    let mut paths = Vec::new();
    let mut rest = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let path = line
            .trim()
            .strip_prefix("Original attachment saved at: \"")
            .and_then(|rest| rest.strip_suffix('"'))
            .and_then(local_path);
        match path {
            Some(path) => paths.push(path),
            None => rest.push_str(line),
        }
    }
    (rest, paths)
}

/// The `MEDIA:<path>` markers of `text` — an absolute path or one from `~`,
/// also in quotes or backticks, outside fenced blocks and inline code — and
/// the text without them and without `[[audio_as_voice]]` and
/// `[[as_document]]`. A text carrying the markers in a JSON value (Hermes
/// replay) is read through it.
pub(crate) fn media_lines(text: &str) -> (String, Vec<String>) {
    if !text.contains("MEDIA:") {
        return (text.to_string(), Vec::new());
    }
    if let Some(found) = json_media(text) {
        return found;
    }
    let mut paths = Vec::new();
    let mut rest = String::with_capacity(text.len());
    let mut fenced = false;
    for line in text.split_inclusive('\n') {
        let marker = line.trim_start();
        if marker.starts_with("```") || marker.starts_with("~~~") {
            fenced = !fenced;
            rest.push_str(line);
            continue;
        }
        if fenced {
            rest.push_str(line);
            continue;
        }
        let (kept, found) = line_media(line);
        if found.is_empty() && kept == line {
            rest.push_str(line);
            continue;
        }
        paths.extend(found.into_iter().map(|(_, path)| path));
        if !kept.trim().is_empty() {
            rest.push_str(&kept);
        }
    }
    (rest, paths)
}

/// The markers of one line outside its inline code, with their raw tokens,
/// and the line without them.
fn line_media(line: &str) -> (String, Vec<(String, String)>) {
    let mut kept = line
        .replace("[[audio_as_voice]]", "")
        .replace("[[as_document]]", "");
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(start) = kept[from..].find("MEDIA:").map(|at| at + from) {
        let token_end = start + "MEDIA:".len();
        let boundary = kept[..start]
            .chars()
            .next_back()
            .is_none_or(|before| before.is_whitespace() || "\"'(".contains(before));
        if !boundary || in_inline_code(&kept, start) {
            from = token_end;
            continue;
        }
        let Some((raw, end)) = marker_path(&kept[token_end..]) else {
            from = token_end;
            continue;
        };
        let Some(path) = expand_path(raw) else {
            from = token_end;
            continue;
        };
        found.push((kept[start..token_end + end].to_string(), path));
        kept.replace_range(start..token_end + end, "");
        from = start;
    }
    (kept, found)
}

/// The path after `MEDIA:` and where its marker ends.
fn marker_path(after: &str) -> Option<(&str, usize)> {
    let quote = after.chars().next().filter(|first| "\"'`".contains(*first));
    match quote {
        Some(quote) => {
            let close = after[1..].find(quote)?;
            Some((&after[1..1 + close], close + 2))
        }
        None => {
            let end = after.find(char::is_whitespace).unwrap_or(after.len());
            let path =
                after[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '"', '\'', '`']);
            Some((path, path.len()))
        }
    }
}

/// Whether byte `at` of `line` is inside a backtick span.
fn in_inline_code(line: &str, at: usize) -> bool {
    line[..at].matches('`').count() % 2 == 1 && line[at..].contains('`')
}

/// The markers of a JSON object in `text` (from its first `{` to its last
/// `}`), read in its string values; the text loses the escaped markers.
fn json_media(text: &str) -> Option<(String, Vec<String>)> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let value: Value = serde_json::from_str(text.get(start..=end)?).ok()?;
    let mut strings = Vec::new();
    collect_strings(&value, &mut strings);
    let mut rest = text.to_string();
    let mut paths = Vec::new();
    for string in strings {
        for line in string.split_inclusive('\n') {
            for (token, path) in line_media(line).1 {
                let escaped = serde_json::to_string(&token).unwrap_or_default();
                let escaped = escaped.trim_matches('"');
                let removed = rest.replacen(&format!("\\n{escaped}"), "", 1);
                rest = match removed == rest {
                    true => rest.replacen(escaped, "", 1),
                    false => removed,
                };
                paths.push(path);
            }
        }
    }
    (!paths.is_empty()).then_some((rest, paths))
}

fn collect_strings<'a>(value: &'a Value, strings: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => strings.push(text),
        Value::Array(values) => values
            .iter()
            .for_each(|value| collect_strings(value, strings)),
        Value::Object(map) => map
            .values()
            .for_each(|value| collect_strings(value, strings)),
        _ => {}
    }
}

/// An absolute path, or one from `~`, as a local path.
fn expand_path(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = system_home_dir()?;
        return local_path(home.join(rest).to_str()?);
    }
    local_path(path)
}

/// The local path a `file://` URI or an absolute path names; a network
/// share is not one (`08` security).
pub(crate) fn local_path(uri: &str) -> Option<String> {
    if uri.is_empty() || uri.len() > URI_LIMIT {
        return None;
    }
    let path = match uri.strip_prefix("file://") {
        Some(rest) => {
            let rest = rest.strip_prefix("localhost").unwrap_or(rest);
            let decoded = percent_decode(rest)?;
            match cfg!(windows) && decoded.as_bytes().get(2) == Some(&b':') {
                true => decoded[1..].to_string(),
                false => decoded,
            }
        }
        None => uri.to_string(),
    };
    (Path::new(&path).is_absolute() && !system_path::is_network_path(&path)).then_some(path)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn file_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| bounded(name, NAME_LIMIT))
}

fn mime_kind(mime: &str) -> Option<MediaKind> {
    let (family, _) = mime.split_once('/')?;
    match family.to_ascii_lowercase().as_str() {
        "image" => Some(MediaKind::Image),
        "video" => Some(MediaKind::Video),
        "audio" => Some(MediaKind::Audio),
        _ => Some(MediaKind::File),
    }
}

/// The media kind of a file by its extension; `File` for any other one.
pub(crate) fn extension_kind(path: &str) -> Option<MediaKind> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "heic" | "heif" | "tif"
        | "tiff" | "avif" | "ico" => MediaKind::Image,
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" => MediaKind::Video,
        "mp3" | "wav" | "ogg" | "oga" | "opus" | "m4a" | "aac" | "flac" => MediaKind::Audio,
        _ => MediaKind::File,
    })
}

/// A segment of the existing media file a read tool call names in its
/// `locations` without sending it.
pub(crate) fn read_file(path: &str) -> Option<MediaPart> {
    if extension_kind(path)? == MediaKind::File
        || system_path::is_network_path(path)
        || !Path::new(path).is_file()
    {
        return None;
    }
    Some(MediaPart::new(
        MediaKind::File,
        None,
        Some(path.to_string()),
        None,
        None,
        None,
    ))
}

/// The MIME type and base64 data of a `data:` URL.
pub(crate) fn data_url(url: &str) -> Option<(&str, &str)> {
    let (header, data) = url.strip_prefix("data:")?.split_once(',')?;
    let mime = header.strip_suffix(";base64")?;
    let mime = mime.split(';').next().unwrap_or(mime);
    (!data.is_empty()).then_some((mime, data))
}

/// Bytes of base64 data.
fn decoded_size(data: &str) -> u64 {
    let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count();
    (data.len() as u64 * 3 / 4).saturating_sub(padding as u64)
}

fn is_base64(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
}

/// `text` with base64 runs and data URLs longer than
/// [`INLINE_DATA_LIMIT`] replaced by a mark with their MIME type and size.
/// A base64 run holds upper and lower case letters and digits, so long
/// words and identifiers stay.
pub(crate) fn scrub_inline_data(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut scrubbed = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"data:")
            && let Some((end, mime, data)) = data_url_at(text, index)
        {
            if end - index > INLINE_DATA_LIMIT {
                scrubbed.push_str(&text[copied..index]);
                scrubbed.push_str(&size_mark(Some(mime), data));
                copied = end;
            }
            index = end;
            continue;
        }
        if !is_base64(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        let (mut upper, mut lower, mut digit) = (false, false, false);
        while index < bytes.len() && is_base64(bytes[index]) {
            upper |= bytes[index].is_ascii_uppercase();
            lower |= bytes[index].is_ascii_lowercase();
            digit |= bytes[index].is_ascii_digit();
            index += 1;
        }
        if index - start > INLINE_DATA_LIMIT && upper && lower && digit {
            scrubbed.push_str(&text[copied..start]);
            scrubbed.push_str(&size_mark(None, &text[start..index]));
            copied = index;
        }
    }
    if copied == 0 {
        return text.to_string();
    }
    scrubbed.push_str(&text[copied..]);
    scrubbed
}

/// The end, MIME type and data of a base64 data URL starting at `start`.
fn data_url_at(text: &str, start: usize) -> Option<(usize, &str, &str)> {
    let header_start = start + "data:".len();
    let comma = header_start
        + text[header_start..]
            .bytes()
            .take(MIME_LIMIT + 64)
            .position(|byte| byte == b',')?;
    let mime = text[header_start..comma].strip_suffix(";base64")?;
    let mime = mime.split(';').next().unwrap_or(mime);
    let data_start = comma + 1;
    let data_end = data_start
        + text[data_start..]
            .bytes()
            .take_while(|byte| is_base64(*byte))
            .count();
    (data_end > data_start).then(|| (data_end, mime, &text[data_start..data_end]))
}

fn size_mark(mime: Option<&str>, data: &str) -> String {
    let size = decoded_size(data);
    let size = match size {
        size if size < 1024 => format!("{size} B"),
        size if size < 1024 * 1024 => format!("{:.1} KB", size as f64 / 1024.0),
        size => format!("{:.1} MB", size as f64 / (1024.0 * 1024.0)),
    };
    match mime.filter(|mime| !mime.is_empty() && mime.len() <= MIME_LIMIT) {
        Some(mime) => format!("[{mime}, {size}]"),
        None => format!("[base64 data, {size}]"),
    }
}

#[cfg(test)]
#[path = "media_tests.rs"]
mod tests;
