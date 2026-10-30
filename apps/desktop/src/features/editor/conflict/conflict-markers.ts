/** Marker size Git uses when a path sets no valid `conflict-marker-size`. */
export const DEFAULT_CONFLICT_MARKER_SIZE = 7;

/** Text of an ambiguous block: a marker line, or a line or run of lines between them. */
export interface ConflictText {
  text: string;
  /** A marker line of the path size, which may or may not be a real marker. */
  marker: boolean;
}

/** A block whose marker lines allow more than one split. */
export interface AmbiguousConflict {
  /** Every line of the block as the file holds it, without line endings. */
  lines: ConflictText[];
  /**
   * The text Edit puts in place of the block: the lines between its outer
   * markers, with marker lines apart from the runs of text between them.
   */
  edit: ConflictText[];
}

/**
 * A Git conflict block of a body, by offsets of its marker lines: its sides,
 * or its text when the marker lines allow more than one split.
 */
export type ConflictBlock = {
  /** Offset of the first `<` marker line. */
  start: number;
  /** Offset after the line ending of the last `>` marker line. */
  end: number;
} & (
  | { ours: string; theirs: string; ambiguous: null }
  | { ambiguous: AmbiguousConflict }
);

type MarkerKind = "<" | "|" | "=" | ">";

interface Line {
  start: number;
  /** Offset of the line ending, which is not part of the line. */
  contentEnd: number;
  /** Offset after the line ending. */
  end: number;
  kind: MarkerKind | null;
}

/**
 * Whether a line of `body` starts with a run of `<` and a space, the only way a
 * conflict block of any marker size can open.
 */
export function hasConflictMarkerCandidate(body: string): boolean {
  return /(?:^|\n)<+ /.test(body);
}

/**
 * The marker line kind of `text` for markers of `size`: `size` copies of `<`
 * or `>` with a space and a label, of `|` alone or with a space and a label,
 * or exactly `size` copies of `=`.
 */
function markerKind(text: string, size: number): MarkerKind | null {
  const marker = text[0];
  if (marker !== "<" && marker !== "|" && marker !== "=" && marker !== ">")
    return null;
  if (text.length < size) return null;
  for (let index = 1; index < size; index++)
    if (text[index] !== marker) return null;
  const next = text[size];
  if (marker === "=") return next === undefined ? marker : null;
  if (marker === "|") return next === undefined || next === " " ? marker : null;
  return next === " " ? marker : null;
}

/** Lines as Git reads them: up to `\n`, with a `\r` before it in the ending. */
function splitLines(body: string, size: number): Line[] {
  const lines: Line[] = [];
  for (let start = 0; start < body.length; ) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline + 1;
    let contentEnd = newline === -1 ? body.length : newline;
    if (newline !== -1 && contentEnd > start && body[contentEnd - 1] === "\r")
      contentEnd -= 1;
    lines.push({
      start,
      contentEnd,
      end,
      kind: markerKind(body.slice(start, contentEnd), size),
    });
    start = end;
  }
  return lines;
}

interface Split {
  lt: number;
  /** The base marker line in the `diff3` style, otherwise -1. */
  bar: number;
  eq: number;
  gt: number;
}

/**
 * Conflict blocks of `body` with markers of `size`. All blocks of a file share
 * one style: it is `diff3`/`zdiff3` when every block has a `|` line before its
 * `=` line, otherwise `merge`, where `|` lines are side content. A block takes
 * the first `<` line, the first `|` line in the `diff3` style, the first `=`
 * line after it and the first `>` line after that; other marker lines inside
 * are content. A `<` line without `=` and `>` lines after it stays text. A
 * block whose marker lines allow another split is ambiguous: it runs from its
 * first `<` line to the last `>` line before the next block and keeps its text.
 */
export function findConflictBlocks(
  body: string,
  size: number,
): ConflictBlock[] {
  const lines = splitLines(body, size);
  const find = (kind: MarkerKind, from: number, to = lines.length) => {
    for (let index = from; index < to; index++)
      if (lines[index].kind === kind) return index;
    return -1;
  };
  const splitFrom = (from: number, diff3: boolean): Split | null => {
    const lt = find("<", from);
    if (lt < 0) return null;
    const bar = diff3 ? find("|", lt + 1) : -1;
    if (diff3 && bar < 0) return null;
    const eq = find("=", (diff3 ? bar : lt) + 1);
    if (eq < 0) return null;
    const gt = find(">", eq + 1);
    if (gt < 0) return null;
    return { lt, bar, eq, gt };
  };
  const splitAll = (diff3: boolean) => {
    const splits: Split[] = [];
    for (let split = splitFrom(0, diff3); split; ) {
      splits.push(split);
      split = splitFrom(split.gt + 1, diff3);
    }
    return splits;
  };

  const mergeSplits = splitAll(false);
  const diff3 =
    mergeSplits.length > 0 &&
    mergeSplits.every(({ lt, gt }) => {
      const bar = find("|", lt + 1, gt);
      return bar >= 0 && find("=", bar + 1, gt) >= 0;
    });
  const splits = diff3 ? splitAll(true) : mergeSplits;

  // Text between marker lines `from` and `to`, without the ending of its last line.
  const side = (from: number, to: number) =>
    to - from > 1
      ? body.slice(lines[from + 1].start, lines[to - 1].contentEnd)
      : "";
  const text = (line: Line) => body.slice(line.start, line.contentEnd);
  const count = (kind: MarkerKind, from: number, to: number) =>
    lines.slice(from, to).filter((line) => line.kind === kind).length;
  const ambiguousConflict = (
    lt: number,
    eq: number,
    last: number,
  ): AmbiguousConflict => {
    // An outer marker line stays out of Edit only when no other line of its
    // kind could be that marker.
    const from = count("<", lt, last + 1) === 1 ? lt + 1 : lt;
    const to = count(">", eq + 1, last + 1) === 1 ? last : last + 1;
    const edit: ConflictText[] = [];
    let run = -1;
    for (let index = from; index <= to; index++) {
      if (index < to && lines[index].kind === null) {
        if (run < 0) run = index;
        continue;
      }
      if (run >= 0)
        edit.push({
          text: body.slice(lines[run].start, lines[index - 1].contentEnd),
          marker: false,
        });
      run = -1;
      if (index < to) edit.push({ text: text(lines[index]), marker: true });
    }
    return {
      lines: lines.slice(lt, last + 1).map((line) => ({
        text: text(line),
        marker: line.kind !== null,
      })),
      edit,
    };
  };

  return splits.map((split, index): ConflictBlock => {
    const { lt, bar, eq, gt } = split;
    const limit = splits[index + 1]?.lt ?? lines.length;
    const ambiguous =
      // A `<` line before the block without its own `=` and `>` lines.
      find("<", lt + 1, diff3 ? bar : eq) >= 0 ||
      // A second `|` line in the `diff3` style.
      (diff3 && find("|", bar + 1, eq) >= 0) ||
      // A second `=` line.
      find("=", eq + 1, gt) >= 0 ||
      // A `>` line in "theirs".
      find(">", gt + 1, limit) >= 0;
    if (!ambiguous)
      return {
        start: lines[lt].start,
        end: lines[gt].end,
        ours: side(lt, diff3 ? bar : eq),
        theirs: side(eq, gt),
        ambiguous: null,
      };
    let last = gt;
    for (let line = gt + 1; line < limit; line++)
      if (lines[line].kind === ">") last = line;
    return {
      start: lines[lt].start,
      end: lines[last].end,
      ambiguous: ambiguousConflict(lt, eq, last),
    };
  });
}
