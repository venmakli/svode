use std::fmt::Write as _;

use serde::Serialize;

/// Byte span of a markdown link `[text](url)` in the source content.
#[derive(Debug, Clone, Serialize)]
pub struct LinkSpan {
    pub byte_start: usize,
    pub byte_end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkDestinationStyle {
    Plain,
    Angle,
    /// Plain destination with at least one decoded `%XX`. `non_ascii` records
    /// that it percent-encoded non-ASCII characters, so a rewrite encodes them too.
    PercentEncoded {
        non_ascii: bool,
    },
}

/// Parsed ordinary inline Markdown link. Spans are byte offsets into the
/// original content. Reference-style links and images are intentionally absent.
#[derive(Debug, Clone)]
pub struct MarkdownLink {
    pub full_start: usize,
    pub full_end: usize,
    pub label_start: usize,
    pub label_end: usize,
    pub destination_outer_start: usize,
    pub destination_outer_end: usize,
    pub path: String,
    pub anchor: String,
    pub style: LinkDestinationStyle,
}

/// Parse standard markdown links `[text](./path.md)` from content.
/// Returns vec of (normalized_target_path, LinkSpan).
/// Only matches relative .md paths (not http, mailto, #anchors).
pub fn parse_markdown_links(content: &str) -> Vec<(String, LinkSpan)> {
    parse_markdown_link_nodes(content)
        .into_iter()
        .map(|link| {
            (
                link.path,
                LinkSpan {
                    byte_start: link.full_start,
                    byte_end: link.full_end,
                },
            )
        })
        .collect()
}

pub fn parse_markdown_link_nodes(content: &str) -> Vec<MarkdownLink> {
    let bytes = content.as_bytes();
    let mut links = Vec::new();
    let mut cursor = 0usize;

    while let Some(open_rel) = content[cursor..].find('[') {
        let open = cursor + open_rel;
        if open > 0 && bytes[open - 1] == b'!' {
            cursor = open + 1;
            continue;
        }

        let Some(label_close) = find_unescaped_byte(content, open + 1, b']') else {
            break;
        };
        let paren_open = label_close + 1;
        if bytes.get(paren_open) != Some(&b'(') {
            cursor = label_close + 1;
            continue;
        }

        let dest_start = paren_open + 1;
        let (style, destination_outer_start, destination_outer_end, destination) =
            if bytes.get(dest_start) == Some(&b'<') {
                let inner_start = dest_start + 1;
                let Some(angle_close) = find_unescaped_byte(content, inner_start, b'>') else {
                    cursor = dest_start;
                    continue;
                };
                let Some(paren_close) = find_unescaped_byte(content, angle_close + 1, b')') else {
                    cursor = angle_close + 1;
                    continue;
                };
                (
                    LinkDestinationStyle::Angle,
                    dest_start,
                    angle_close + 1,
                    &content[inner_start..angle_close],
                )
                    .with_full_end(paren_close + 1)
            } else {
                let Some(paren_close) = find_unescaped_byte(content, dest_start, b')') else {
                    cursor = dest_start;
                    continue;
                };
                let Some(destination_end) =
                    plain_destination_end(&content[dest_start..paren_close])
                else {
                    cursor = paren_close + 1;
                    continue;
                };
                (
                    LinkDestinationStyle::Plain,
                    dest_start,
                    dest_start + destination_end,
                    &content[dest_start..dest_start + destination_end],
                )
                    .with_full_end(paren_close + 1)
            };

        let full_end = destination.full_end;
        let destination = destination.value;
        if let Some((path, anchor, form)) = parse_internal_markdown_destination(destination) {
            let style = match style {
                LinkDestinationStyle::Plain if form.decoded => {
                    LinkDestinationStyle::PercentEncoded {
                        non_ascii: form.non_ascii,
                    }
                }
                style => style,
            };
            links.push(MarkdownLink {
                full_start: open,
                full_end,
                label_start: open + 1,
                label_end: label_close,
                destination_outer_start,
                destination_outer_end,
                path,
                anchor,
                style,
            });
        }
        cursor = full_end;
    }

    links
}

struct ParsedDestination<'a> {
    value: &'a str,
    full_end: usize,
}

trait DestinationWithFullEnd<'a> {
    fn with_full_end(
        self,
        full_end: usize,
    ) -> (LinkDestinationStyle, usize, usize, ParsedDestination<'a>);
}

impl<'a> DestinationWithFullEnd<'a> for (LinkDestinationStyle, usize, usize, &'a str) {
    fn with_full_end(
        self,
        full_end: usize,
    ) -> (LinkDestinationStyle, usize, usize, ParsedDestination<'a>) {
        (
            self.0,
            self.1,
            self.2,
            ParsedDestination {
                value: self.3,
                full_end,
            },
        )
    }
}

fn find_unescaped_byte(content: &str, start: usize, needle: u8) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut idx = start;
    while idx < bytes.len() {
        if bytes[idx] == needle && !is_escaped(bytes, idx) {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

fn is_escaped(bytes: &[u8], idx: usize) -> bool {
    let mut count = 0usize;
    let mut cursor = idx;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        count += 1;
        cursor -= 1;
    }
    count % 2 == 1
}

fn plain_destination_end(destination_with_suffix: &str) -> Option<usize> {
    let trimmed_end = destination_with_suffix.trim_end().len();
    let candidate = &destination_with_suffix[..trimmed_end];
    if candidate.is_empty() {
        return None;
    }

    let mut search_start = 0usize;
    let lower = candidate.to_ascii_lowercase();
    let mut best = None;
    while let Some(offset) = lower[search_start..].find(".md") {
        let md_end = search_start + offset + ".md".len();
        let mut end = md_end;
        if candidate[end..].starts_with('#') {
            let anchor_start = end + 1;
            let mut anchor_end = candidate.len();
            for (idx, ch) in candidate[anchor_start..].char_indices() {
                if ch.is_whitespace() {
                    anchor_end = anchor_start + idx;
                    break;
                }
            }
            end = if anchor_end == anchor_start {
                md_end
            } else {
                anchor_end
            };
            if end == md_end {
                end = md_end;
            }
        }
        if end == candidate.len()
            || candidate[end..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            best = Some(end);
        }
        search_start = md_end;
    }

    best.or(Some(trimmed_end))
}

/// Split a destination into its decoded, normalized path and its raw anchor.
/// The anchor is cut before percent-decoding, so an encoded `#` stays part of
/// the path; the anchor itself is never decoded.
fn parse_internal_markdown_destination(destination: &str) -> Option<(String, String, PercentForm)> {
    let unescaped;
    let destination = if destination.contains("\\<") || destination.contains("\\>") {
        unescaped = destination.replace("\\<", "<").replace("\\>", ">");
        unescaped.as_str()
    } else {
        destination
    };
    if is_external_or_anchor_url(destination) {
        return None;
    }
    let (path_part, anchor) = match destination.find('#') {
        Some(pos) => (&destination[..pos], &destination[pos..]),
        None => (destination, ""),
    };
    let (path, mut form) = percent_decode_link_path(path_part);
    if path.is_empty() || !path.to_ascii_lowercase().ends_with(".md") {
        return None;
    }
    let anchor_form = percent_decode_link_path(anchor).1;
    form.decoded |= anchor_form.decoded;
    form.non_ascii |= anchor_form.non_ascii;
    Some((
        normalize_link_path_preserve_parent(&path),
        anchor.to_string(),
        form,
    ))
}

/// What percent-decoding found in a destination.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PercentForm {
    /// At least one `%XX` was decoded.
    pub decoded: bool,
    /// A decoded `%XX` sequence produced a non-ASCII character.
    pub non_ascii: bool,
}

/// Percent-decode a link path once, as UTF-8. Every `%XX` with two hex digits
/// is decoded; a `%` without them and escapes that do not form valid UTF-8
/// stay literal.
pub(crate) fn percent_decode_link_path(raw: &str) -> (String, PercentForm) {
    let bytes = raw.as_bytes();
    if !bytes.contains(&b'%') {
        return (raw.to_string(), PercentForm::default());
    }
    // Decoded bytes with the source offset of the `%` they were decoded from.
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut escapes = Vec::with_capacity(bytes.len());
    let mut idx = 0usize;
    while idx < bytes.len() {
        let escaped = if bytes[idx] == b'%' && idx + 2 < bytes.len() {
            hex_value(bytes[idx + 1]).zip(hex_value(bytes[idx + 2]))
        } else {
            None
        };
        if let Some((high, low)) = escaped {
            let byte = (high << 4) | low;
            decoded.push(byte);
            escapes.push(Some(idx));
            idx += 3;
        } else {
            decoded.push(bytes[idx]);
            escapes.push(None);
            idx += 1;
        }
    }

    let mut out = String::with_capacity(decoded.len());
    let mut form = PercentForm::default();
    let mut start = 0usize;
    while start < decoded.len() {
        let (valid_end, invalid) = match std::str::from_utf8(&decoded[start..]) {
            Ok(_) => (decoded.len(), false),
            Err(error) => (start + error.valid_up_to(), true),
        };
        let valid = std::str::from_utf8(&decoded[start..valid_end]).unwrap_or_default();
        for (offset, ch) in valid.char_indices() {
            let at = start + offset;
            if escapes[at..at + ch.len_utf8()].iter().any(Option::is_some) {
                form.decoded = true;
                form.non_ascii |= !ch.is_ascii();
            }
        }
        out.push_str(valid);
        if !invalid {
            break;
        }
        // Only a decoded byte can start an invalid sequence: the raw bytes of
        // the input always form whole characters. Keep its source literally.
        match escapes[valid_end] {
            Some(source) => out.push_str(&raw[source..source + 3]),
            None => out.push(char::REPLACEMENT_CHARACTER),
        }
        start = valid_end + 1;
    }
    (out, form)
}

fn hex_value(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|value| value as u8)
}

/// Percent-encode a link path for a percent-encoded destination: whitespace,
/// control characters, `<`, `>`, `(`, `)`, `[`, `]`, `#` and `%` always, and
/// non-ASCII characters when the original destination encoded them.
pub(crate) fn percent_encode_link_path(path: &str, non_ascii: bool) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        let encode = ch.is_whitespace()
            || ch.is_control()
            || matches!(ch, '<' | '>' | '(' | ')' | '[' | ']' | '#' | '%')
            || (non_ascii && !ch.is_ascii());
        if encode {
            let mut buffer = [0u8; 4];
            for byte in ch.encode_utf8(&mut buffer).bytes() {
                let _ = write!(out, "%{byte:02X}");
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Encode a literal `%` of a Markdown link path as `%25`, so the written link
/// decodes back to exactly this path.
pub(crate) fn escape_literal_percent(path: &str) -> String {
    path.replace('%', "%25")
}

/// Normalize a link URL while preserving leading `..` segments. This is the
/// parser-facing form; resolver code decides whether the path escapes a root.
pub fn normalize_link_path_preserve_parent(path: &str) -> String {
    let p = path.strip_prefix("./").unwrap_or(path);
    let mut parts: Vec<&str> = Vec::new();
    let mut leading_parents = 0usize;
    for segment in p.split('/') {
        match segment {
            "." | "" => continue,
            ".." => {
                if parts.pop().is_none() {
                    leading_parents += 1;
                }
            }
            s => parts.push(s),
        }
    }
    let mut out: Vec<String> = Vec::with_capacity(leading_parents + parts.len());
    for _ in 0..leading_parents {
        out.push("..".to_string());
    }
    out.extend(parts.into_iter().map(ToString::to_string));
    out.join("/")
}

fn is_external_or_anchor_url(url: &str) -> bool {
    let url = url
        .trim()
        .strip_prefix('<')
        .and_then(|inner| inner.strip_suffix('>'))
        .unwrap_or(url.trim());
    url.starts_with('#') || url.starts_with("//") || has_url_scheme(url)
}

fn has_url_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}
