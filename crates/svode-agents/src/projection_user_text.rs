//! The text of a user message as the agent sent it, which later chunks
//! extend, and as its item shows it: without the block a Routine launch
//! appends to its instruction (DF-224), within the detail bound, however
//! the agent chunks it and beyond the bound (Stage 10 `02` C4).

use super::{bounded_segments, ceil_char_boundary, floor_char_boundary, head_budget, tail_budget};
use crate::activity::{DetailBlock, MessageSegment};
use crate::registry::{
    RoutineBlockEnd, RoutineBlockScan, routine_block_start, strip_routine_block,
};

/// What later chunks of a user message extend besides its detail.
#[derive(Default)]
pub(super) struct UserText {
    /// Segments of a message with links or images as the agent sent them.
    segments: Vec<MessageSegment>,
    /// Bytes of text put in `segments`, also beyond their bound.
    segment_text: usize,
    /// A Routine block the message may end with beyond the detail bound.
    block: Option<BlockStart>,
}

/// A Routine block a message beyond the detail bound may end with: the
/// message before it, and what tells whether the block is whole.
struct BlockStart {
    before: Before,
    scan: RoutineBlockScan,
}

enum Before {
    /// The block starts at this byte of the detail head.
    InHead(usize),
    /// The block starts after the head: the characters omitted after the
    /// head and the text up to the block.
    After { omitted_chars: u64, tail: String },
}

impl UserText {
    /// The text of a prompt with its `segments`.
    pub(super) fn of_prompt(segments: Vec<MessageSegment>) -> Self {
        Self {
            segment_text: text_bytes(&segments),
            segments: bounded_segments(segments),
            block: None,
        }
    }

    /// Bytes held besides the detail.
    pub(super) fn size(&self) -> usize {
        self.block.as_ref().map_or(0, |block| {
            block.scan.size()
                + match &block.before {
                    Before::InHead(_) => 0,
                    Before::After { tail, .. } => tail.len(),
                }
        })
    }

    /// Drops what only the detail needs, when it is released.
    pub(super) fn release(&mut self) {
        self.block = None;
    }

    /// The segments with the next chunk, `text` or its own segments: a
    /// message turns into segments with its first link or image, after the
    /// text so far in `known`.
    pub(super) fn extend_segments(
        &mut self,
        known: &DetailBlock,
        text: &str,
        chunk: Vec<MessageSegment>,
    ) {
        if chunk.is_empty() {
            if !self.segments.is_empty() {
                self.segment_text += text.len();
                self.segments.push(MessageSegment::Text {
                    text: text.to_string(),
                });
                self.segments = bounded_segments(std::mem::take(&mut self.segments));
            }
            return;
        }
        if self.segments.is_empty() {
            let before = match known {
                DetailBlock::Text { text } => text.as_str(),
                DetailBlock::Excerpt { head, .. } => head.as_str(),
                DetailBlock::Diff { .. } | DetailBlock::Terminal { .. } => "",
            };
            self.segment_text = before.len();
            self.segments.push(MessageSegment::Text {
                text: before.to_string(),
            });
        }
        self.segment_text += text_bytes(&chunk);
        self.segments.extend(chunk);
        self.segments = bounded_segments(std::mem::take(&mut self.segments));
    }

    /// The detail `known` with the next chunk `more` within `limit`: within
    /// it the text itself, beyond it its head and tail. While the message
    /// may end with a Routine block beyond the bound, the text before the
    /// block and the newest text share the tail.
    pub(super) fn extend(&mut self, known: DetailBlock, more: &str, limit: usize) -> DetailBlock {
        let share = tail_budget(limit) / 2;
        match known {
            DetailBlock::Text { mut text } => {
                text.push_str(more);
                if text.len() <= limit {
                    return DetailBlock::Text { text };
                }
                let head_end = floor_char_boundary(&text, head_budget(limit));
                self.block = routine_block_start(&text).map(|(start, scan)| BlockStart {
                    before: if start <= head_end {
                        Before::InHead(start)
                    } else {
                        before(&text[head_end..start], 0, share)
                    },
                    scan,
                });
                let tail_start =
                    ceil_char_boundary(&text, text.len().saturating_sub(self.tail_budget(limit)))
                        .max(head_end);
                DetailBlock::Excerpt {
                    head: text[..head_end].to_string(),
                    omitted_chars: text[head_end..tail_start].chars().count() as u64,
                    tail: text[tail_start..].to_string(),
                }
            }
            DetailBlock::Excerpt {
                head,
                mut omitted_chars,
                tail,
            } => {
                let mut window = tail;
                window.push_str(more);
                if let Some(block) = &mut self.block {
                    block.scan.push(more);
                }
                self.block.take_if(|block| !block.scan.alive());
                if self.block.is_none() {
                    self.block = routine_block_start(&window).map(|(start, scan)| BlockStart {
                        before: before(&window[..start], omitted_chars, share),
                        scan,
                    });
                }
                let cut = ceil_char_boundary(
                    &window,
                    window.len().saturating_sub(self.tail_budget(limit)),
                );
                omitted_chars += window[..cut].chars().count() as u64;
                DetailBlock::Excerpt {
                    head,
                    omitted_chars,
                    tail: window[cut..].to_string(),
                }
            }
            other => other,
        }
    }

    /// The newest text of a detail beyond the bound: all of the tail, or
    /// what the text before a possible Routine block leaves of it.
    fn tail_budget(&self, limit: usize) -> usize {
        let budget = tail_budget(limit);
        match self.block {
            Some(_) => budget - budget / 2,
            None => budget,
        }
    }

    /// The text the detail `raw` shows: without a whole Routine block at its
    /// end and the whitespace before it, with the bytes of text that leaves
    /// out.
    pub(super) fn shown(&self, raw: &DetailBlock) -> (DetailBlock, usize) {
        match (raw, &self.block) {
            (DetailBlock::Excerpt { head, .. }, Some(block))
                if block.scan.end() == Some(RoutineBlockEnd::Whole) =>
            {
                // The whitespace before the block goes with it.
                let (shown, whitespace) = match &block.before {
                    Before::InHead(start) => {
                        let text = &head[..*start];
                        let shown = text.trim_end();
                        (text_block(shown), text.len() - shown.len())
                    }
                    Before::After {
                        omitted_chars: 0,
                        tail,
                    } => {
                        let text = format!("{head}{tail}");
                        let shown = text.trim_end();
                        (text_block(shown), text.len() - shown.len())
                    }
                    Before::After {
                        omitted_chars,
                        tail,
                    } => {
                        let shown = tail.trim_end();
                        (
                            DetailBlock::Excerpt {
                                head: head.clone(),
                                omitted_chars: *omitted_chars,
                                tail: shown.to_string(),
                            },
                            tail.len() - shown.len(),
                        )
                    }
                };
                (shown, whitespace + block.scan.len())
            }
            (DetailBlock::Text { text }, _) => {
                let shown = strip_routine_block(text, RoutineBlockEnd::Whole);
                (text_block(shown), text.len() - shown.len())
            }
            (
                DetailBlock::Excerpt {
                    head,
                    omitted_chars,
                    tail,
                },
                _,
            ) => {
                let shown = strip_routine_block(tail, RoutineBlockEnd::Whole);
                (
                    DetailBlock::Excerpt {
                        head: head.clone(),
                        omitted_chars: *omitted_chars,
                        tail: shown.to_string(),
                    },
                    tail.len() - shown.len(),
                )
            }
            (other, _) => (other.clone(), 0),
        }
    }

    /// The segments without the `removed` bytes of text at their end and
    /// what follows them.
    pub(super) fn shown_segments(&self, removed: usize) -> Vec<MessageSegment> {
        if removed == 0 {
            return self.segments.clone();
        }
        let keep = self.segment_text.saturating_sub(removed);
        let mut text_bytes = 0;
        let mut shown = Vec::with_capacity(self.segments.len());
        for segment in &self.segments {
            match segment {
                MessageSegment::Text { text } => {
                    if text_bytes < keep {
                        let end = floor_char_boundary(text, (keep - text_bytes).min(text.len()));
                        shown.push(MessageSegment::Text {
                            text: text[..end].to_string(),
                        });
                    }
                    text_bytes += text.len();
                }
                other if text_bytes <= keep => shown.push(other.clone()),
                _ => {}
            }
        }
        shown
    }
}

/// The message before a block from the text `text` after `omitted_chars`,
/// within `share` bytes of the tail.
fn before(text: &str, omitted_chars: u64, share: usize) -> Before {
    let cut = ceil_char_boundary(text, text.len().saturating_sub(share));
    Before::After {
        omitted_chars: omitted_chars + text[..cut].chars().count() as u64,
        tail: text[cut..].to_string(),
    }
}

fn text_block(text: &str) -> DetailBlock {
    DetailBlock::Text {
        text: text.to_string(),
    }
}

fn text_bytes(segments: &[MessageSegment]) -> usize {
    segments
        .iter()
        .map(|segment| match segment {
            MessageSegment::Text { text } => text.len(),
            MessageSegment::Link { .. } | MessageSegment::Image { .. } => 0,
        })
        .sum()
}
