//! The bounded tail of a JSON lines store (Stage 10 `07` N3, N7): agents
//! append one record per line without locks between processes, so a reader
//! sees whole lines and possibly an unfinished last one.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

/// The tail a reader takes unless its agent needs another bound.
pub(crate) const TAIL_BYTES: u64 = 256 * 1024;

/// Every whole, well-formed JSON line within the last `max_bytes` of the
/// file, in order. The line the window cuts at its start and an unfinished
/// last line (no line break yet) are dropped; malformed lines are skipped.
/// The caller keeps only the fields it may hold (N3).
pub(crate) fn for_each_tail_line(
    path: &Path,
    max_bytes: u64,
    mut handle: impl FnMut(Value),
) -> io::Result<()> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    // One byte before the window tells whether its first line is whole.
    let from = start.saturating_sub(1);
    file.seek(SeekFrom::Start(from))?;
    let mut window = Vec::new();
    file.take(len - from).read_to_end(&mut window)?;

    let mut lines = window.as_slice();
    if start > 0 {
        lines = match lines.iter().position(|byte| *byte == b'\n') {
            Some(end) => &lines[end + 1..],
            None => &[],
        };
    }
    lines = match lines.iter().rposition(|byte| *byte == b'\n') {
        Some(end) => &lines[..end],
        None => &[],
    };
    for line in lines.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            handle(value);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn tail(data: &str, max_bytes: u64) -> Vec<Value> {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(&path, data).expect("write fixture");
        let mut lines = Vec::new();
        for_each_tail_line(&path, max_bytes, |value| lines.push(value)).expect("tail");
        lines
    }

    #[test]
    fn a_tail_longer_than_the_bound_keeps_the_whole_lines_within_it() {
        let data = (0..100)
            .map(|n| format!("{}\n", json!({ "n": n })))
            .collect::<String>();
        let line = format!("{}\n", json!({ "n": 99 })).len() as u64;

        let lines = tail(&data, line * 3 + 2);
        assert_eq!(
            lines,
            vec![json!({ "n": 97 }), json!({ "n": 98 }), json!({ "n": 99 })],
            "the line the bound cuts is dropped"
        );
        assert_eq!(
            tail(&data, line * 2),
            vec![json!({ "n": 98 }), json!({ "n": 99 })],
            "a window starting at a line keeps it"
        );
    }

    #[test]
    fn an_unfinished_last_line_is_dropped() {
        assert_eq!(
            tail("{\"n\":1}\n{\"n\":2}\n{\"n\":", TAIL_BYTES),
            vec![json!({ "n": 1 }), json!({ "n": 2 })]
        );
        assert_eq!(
            tail("{\"n\":1}\n{\"n\":2}", TAIL_BYTES),
            vec![json!({ "n": 1 })],
            "a last line without its break may still be written"
        );
    }

    #[test]
    fn malformed_and_blank_lines_are_skipped() {
        assert_eq!(
            tail("{\"n\":1}\r\nnot json\n\n{\"n\":2}\n", TAIL_BYTES),
            vec![json!({ "n": 1 }), json!({ "n": 2 })]
        );
        assert!(tail("", TAIL_BYTES).is_empty());
    }
}
