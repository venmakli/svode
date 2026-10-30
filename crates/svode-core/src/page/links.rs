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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownLinkKind {
    /// Inline link `[text](path.md)`.
    Inline,
    /// Link reference definition `[label]: path.md "title"`. It holds the
    /// address of every reference link that uses its label, so it is the
    /// link unit; uses such as `[text][label]` are not links of their own.
    Definition,
}

/// Parsed internal Markdown link: an inline link or a link reference
/// definition. Spans are byte offsets into the original content. Images and
/// reference link uses are absent.
///
/// For an inline link the label is the link text between the brackets; for a
/// definition it is the label between the brackets and `full_end` is the end
/// of its title, or of its destination without a title.
#[derive(Debug, Clone)]
pub struct MarkdownLink {
    pub kind: MarkdownLinkKind,
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

/// Parse internal links of a Markdown file: inline links `[text](./path.md)`
/// and link reference definitions `[label]: ./path.md` of its body.
/// Returns vec of (normalized_target_path, LinkSpan).
/// Only matches relative .md paths (not http, mailto, #anchors).
pub fn parse_markdown_links(content: &str) -> Vec<(String, LinkSpan)> {
    link_spans(parse_markdown_link_nodes(content))
}

/// Parse internal links of a Page body whose frontmatter is already removed.
pub fn parse_markdown_body_links(body: &str) -> Vec<(String, LinkSpan)> {
    link_spans(link_nodes(body, 0))
}

fn link_spans(links: Vec<MarkdownLink>) -> Vec<(String, LinkSpan)> {
    links
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

/// Internal links of a Markdown file in source order. Definitions are found
/// only in the body after the frontmatter.
pub fn parse_markdown_link_nodes(content: &str) -> Vec<MarkdownLink> {
    link_nodes(content, crate::page::frontmatter::body_start(content))
}

fn link_nodes(content: &str, body_start: usize) -> Vec<MarkdownLink> {
    let mut links = parse_inline_link_nodes(content);
    let definitions = parse_definition_nodes(content, body_start);
    if !definitions.is_empty() {
        links.extend(definitions);
        links.sort_by_key(|link| link.full_start);
    }
    links
}

fn parse_inline_link_nodes(content: &str) -> Vec<MarkdownLink> {
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
            let style = written_style(style, form);
            links.push(MarkdownLink {
                kind: MarkdownLinkKind::Inline,
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

fn written_style(style: LinkDestinationStyle, form: PercentForm) -> LinkDestinationStyle {
    match style {
        LinkDestinationStyle::Plain if form.decoded => LinkDestinationStyle::PercentEncoded {
            non_ascii: form.non_ascii,
        },
        style => style,
    }
}

/// Link reference definitions of the body that starts at `body_start`, as
/// CommonMark recognizes them: at the start of a block and not as a paragraph
/// continuation, also in block quotes and list items, never in code or HTML
/// blocks. Footnote definitions `[^1]: ...` are footnotes, as in GFM.
fn parse_definition_nodes(content: &str, body_start: usize) -> Vec<MarkdownLink> {
    let body = &content[body_start..];
    // Every definition has `]:` right after its label.
    if !body.contains("]:") {
        return Vec::new();
    }
    let mut options = markdown::ParseOptions::default();
    options.constructs.gfm_footnote_definition = true;
    // Only MDX constructs fail to parse, and they are off.
    let Ok(tree) = markdown::to_mdast(body, &options) else {
        return Vec::new();
    };
    let mut links = Vec::new();
    let mut stack = vec![&tree];
    while let Some(node) = stack.pop() {
        if let markdown::mdast::Node::Definition(definition) = node {
            if let Some(position) = &definition.position {
                links.extend(
                    definition_link(body, position.start.offset, position.end.offset).map(|link| {
                        MarkdownLink {
                            full_start: link.full_start + body_start,
                            full_end: link.full_end + body_start,
                            label_start: link.label_start + body_start,
                            label_end: link.label_end + body_start,
                            destination_outer_start: link.destination_outer_start + body_start,
                            destination_outer_end: link.destination_outer_end + body_start,
                            ..link
                        }
                    }),
                );
            }
        } else if let Some(children) = node.children() {
            stack.extend(children.iter().rev());
        }
    }
    links
}

/// Read the label and destination of the definition the parser found at
/// `start..end` of `body`.
fn definition_link(body: &str, start: usize, end: usize) -> Option<MarkdownLink> {
    let bytes = body.as_bytes();
    let open = start + body.get(start..end)?.find('[')?;
    let label_close = find_unescaped_byte(body, open + 1, b']').filter(|close| *close < end)?;
    if bytes.get(label_close + 1) != Some(&b':') {
        return None;
    }

    // The destination may follow on the next line, after the block quote
    // markers of the containers the definition starts in.
    let line_start = body[..open].rfind(['\n', '\r']).map_or(0, |idx| idx + 1);
    let quote_markers = body[line_start..open].matches('>').count();
    let mut cursor = skip_spaces(bytes, label_close + 2);
    if let Some(line_end) = line_ending_len(bytes, cursor) {
        cursor += line_end;
        for _ in 0..quote_markers {
            let marker = skip_spaces(bytes, cursor);
            if bytes.get(marker) != Some(&b'>') {
                break;
            }
            cursor = marker + 1;
        }
        cursor = skip_spaces(bytes, cursor);
    }

    let destination_outer_start = cursor;
    let (style, destination_outer_end, destination) = if bytes.get(cursor) == Some(&b'<') {
        let angle_close =
            find_unescaped_byte(body, cursor + 1, b'>').filter(|close| *close < end)?;
        (
            LinkDestinationStyle::Angle,
            angle_close + 1,
            &body[cursor + 1..angle_close],
        )
    } else {
        let destination_end = body[cursor..end]
            .find(|ch: char| ch.is_ascii_whitespace() || ch.is_ascii_control())
            .map_or(end, |idx| cursor + idx);
        (
            LinkDestinationStyle::Plain,
            destination_end,
            &body[cursor..destination_end],
        )
    };
    let (path, anchor, form) = parse_internal_markdown_destination(destination)?;
    Some(MarkdownLink {
        kind: MarkdownLinkKind::Definition,
        full_start: open,
        full_end: end,
        label_start: open + 1,
        label_end: label_close,
        destination_outer_start,
        destination_outer_end,
        path,
        anchor,
        style: written_style(style, form),
    })
}

fn skip_spaces(bytes: &[u8], mut idx: usize) -> usize {
    while matches!(bytes.get(idx), Some(b' ' | b'\t')) {
        idx += 1;
    }
    idx
}

fn line_ending_len(bytes: &[u8], idx: usize) -> Option<usize> {
    match (bytes.get(idx), bytes.get(idx + 1)) {
        (Some(b'\r'), Some(b'\n')) => Some(2),
        (Some(b'\n' | b'\r'), _) => Some(1),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Path, anchor and source text of every definition of `content`.
    fn definitions(content: &str) -> Vec<(String, String, &str)> {
        parse_markdown_link_nodes(content)
            .into_iter()
            .filter(|link| link.kind == MarkdownLinkKind::Definition)
            .map(|link| {
                (
                    link.path,
                    link.anchor,
                    &content[link.full_start..link.full_end],
                )
            })
            .collect()
    }

    fn paths(content: &str) -> Vec<String> {
        definitions(content)
            .into_iter()
            .map(|(path, _, _)| path)
            .collect()
    }

    #[test]
    fn df_251_definition_spans_label_and_destination() {
        let content = "Intro\n\n[Plan]: <./plan b.md> \"Title\"\n";
        let links = parse_markdown_link_nodes(content);
        assert_eq!(links.len(), 1);
        let link = &links[0];
        assert_eq!(link.kind, MarkdownLinkKind::Definition);
        assert_eq!(
            &content[link.full_start..link.full_end],
            "[Plan]: <./plan b.md> \"Title\""
        );
        assert_eq!(&content[link.label_start..link.label_end], "Plan");
        assert_eq!(
            &content[link.destination_outer_start..link.destination_outer_end],
            "<./plan b.md>"
        );
        assert_eq!(link.path, "plan b.md");
        assert_eq!(link.style, LinkDestinationStyle::Angle);
    }

    #[test]
    fn df_251_recognizes_definitions_where_commonmark_does() {
        let cases: &[(&str, &[&str])] = &[
            ("[p]: plan.md\n", &["plan.md"]),
            ("[p]: plan.md \"T\"\n", &["plan.md"]),
            ("[p]: plan.md 'T'\n", &["plan.md"]),
            ("[p]: plan.md (T)\n", &["plan.md"]),
            ("[p]: <my plan.md>\n", &["my plan.md"]),
            ("[p]:\n  plan.md\n  \"Title\"\n", &["plan.md"]),
            ("> [p]: plan.md\n", &["plan.md"]),
            ("> [p]:\n> plan.md\n", &["plan.md"]),
            ("> > [p]:\n> > plan.md\n", &["plan.md"]),
            ("> [p]:\nplan.md\n", &["plan.md"]),
            ("[p]:\r\n  plan.md\r\n", &["plan.md"]),
            ("- [p]: plan.md\n", &["plan.md"]),
            ("1. [p]:\n   plan.md\n", &["plan.md"]),
            ("# Heading\n[p]: plan.md\n", &["plan.md"]),
            (
                "[a]: a.md\n[b]: b.md\n[c]: c.md\n",
                &["a.md", "b.md", "c.md"],
            ),
            ("[p]: a.md\n[p]: b.md\n", &["a.md", "b.md"]),
            ("Text without uses.\n\n[unused]: plan.md\n", &["plan.md"]),
            ("[p]: ../plan.md\n", &["../plan.md"]),
            ("[p]: Roadmap%20Draft.md\n", &["Roadmap Draft.md"]),
            ("   [p]: plan.md\n", &["plan.md"]),
            ("[p]: plan.md\n\"bad\" title\n", &["plan.md"]),
            ("---\ntitle: T\n---\n[p]: plan.md\n", &["plan.md"]),
        ];
        for (content, expected) in cases {
            assert_eq!(paths(content), *expected, "{content:?}");
        }
    }

    #[test]
    fn df_251_skips_what_commonmark_does_not_define() {
        let cases = [
            "```\n[p]: plan.md\n```\n",
            "~~~\n[p]: plan.md\n~~~\n",
            "    [p]: plan.md\n",
            "Paragraph\n[p]: plan.md\n",
            "[^1]: plan.md\n",
            "[//]: #\n",
            "[x]: https://example.com/plan.md\n",
            "[x]: plan.md extra\n",
            "[x]: <plan.md>(T)\n",
            "<div>\n[p]: plan.md\n</div>\n",
            "---\nlink: \"[p]: plan.md\"\n[p]: plan.md\n---\nBody\n",
            "[x]: image.png\n",
        ];
        for content in cases {
            assert_eq!(paths(content), Vec::<String>::new(), "{content:?}");
        }
    }

    #[test]
    fn df_251_definition_anchor_and_percent_form_follow_inline_rules() {
        let content = "[a]: plan.md#раздел\n[b]: %D0%9F%D0%BB%D0%B0%D0%BD.md\n";
        assert_eq!(
            definitions(content),
            vec![
                (
                    "plan.md".to_string(),
                    "#раздел".to_string(),
                    "[a]: plan.md#раздел"
                ),
                (
                    "План.md".to_string(),
                    String::new(),
                    "[b]: %D0%9F%D0%BB%D0%B0%D0%BD.md"
                ),
            ]
        );
        let styles = parse_markdown_link_nodes(content)
            .into_iter()
            .map(|link| link.style)
            .collect::<Vec<_>>();
        assert_eq!(
            styles,
            vec![
                LinkDestinationStyle::Plain,
                LinkDestinationStyle::PercentEncoded { non_ascii: true },
            ]
        );
    }

    #[test]
    fn df_251_inline_links_and_definitions_come_in_source_order() {
        let content = "See [Plan][p] and [inline](a.md).\n\n[p]: plan.md\n\nThen [b](b.md).\n";
        let links = parse_markdown_link_nodes(content);
        let found = links
            .iter()
            .map(|link| (link.kind, link.path.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            found,
            vec![
                (MarkdownLinkKind::Inline, "a.md"),
                (MarkdownLinkKind::Definition, "plan.md"),
                (MarkdownLinkKind::Inline, "b.md"),
            ]
        );
        assert_eq!(
            parse_markdown_body_links("---\n[p]: plan.md\n---\n")
                .into_iter()
                .map(|(path, _)| path)
                .collect::<Vec<_>>(),
            vec!["plan.md".to_string()]
        );
    }
}
