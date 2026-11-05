/** Marker size Git uses when a path sets no valid `conflict-marker-size`. */
export const DEFAULT_CONFLICT_MARKER_SIZE = 7;

/** Text of an ambiguous block: a marker line, or a line or run of lines between them. */
export interface ConflictText {
  text: string;
  /** A marker line of the path size, which may or may not be a real marker. */
  marker: boolean;
}

/** A block, or a place of blocks, whose marker lines allow more than one split. */
export interface AmbiguousConflict {
  /** Every line of the block or place as the file holds it, without line endings. */
  lines: ConflictText[];
  /**
   * The text Edit puts in place of the block or place: its lines without the
   * outer markers that are the only ones of their kind, with marker lines
   * apart from the runs of text between them.
   */
  edit: ConflictText[];
}

/** Text of a body by offsets: `start` inclusive, `end` exclusive. */
export interface TextRange {
  start: number;
  end: number;
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
  /** Offset of the `=` marker line that separates the sides. */
  separator: number;
} & (
  | {
      ours: string;
      theirs: string;
      /** The lines of each side with their line endings. */
      oursLines: TextRange;
      theirsLines: TextRange;
      ambiguous: null;
    }
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
        separator: lines[eq].start,
        ours: side(lt, diff3 ? bar : eq),
        theirs: side(eq, gt),
        oursLines: {
          start: lines[lt].end,
          end: lines[diff3 ? bar : eq].start,
        },
        theirsLines: { start: lines[eq].end, end: lines[gt].start },
        ambiguous: null,
      };
    let last = gt;
    for (let line = gt + 1; line < limit; line++)
      if (lines[line].kind === ">") last = line;
    return {
      start: lines[lt].start,
      end: lines[last].end,
      separator: lines[eq].start,
      ambiguous: ambiguousLines(body, lines, lt, eq, last),
    };
  });
}

/**
 * The text of an ambiguous conflict place of `body` with markers of `size`:
 * its whole lines from `range.start`, the start of a line, to `range.end`,
 * after a line ending or at the end of `body`. `separator` is the offset of
 * the `=` line of the first block of the place.
 */
export function ambiguousConflictText(
  body: string,
  size: number,
  range: TextRange,
  separator: number,
): AmbiguousConflict {
  const text = body.slice(range.start, range.end);
  const lines = splitLines(text, size);
  return ambiguousLines(
    text,
    lines,
    0,
    lines.findIndex((line) => line.start === separator - range.start),
    lines.length - 1,
  );
}

/**
 * The text of the lines `first` to `last` of `body`, an ambiguous place whose
 * first block separates its sides at the line `eq`. Its outer marker lines
 * are the first `<` line and the last `>` line; Edit leaves one out only when
 * no other line of its kind could be that marker: no other `<` line in the
 * place, no other `>` line after `eq`.
 */
function ambiguousLines(
  body: string,
  lines: Line[],
  first: number,
  eq: number,
  last: number,
): AmbiguousConflict {
  const text = (line: Line) => body.slice(line.start, line.contentEnd);
  const place = lines.slice(first, last + 1);
  const count = (kind: MarkerKind, from: number) =>
    place.slice(from).filter((line) => line.kind === kind).length;
  const outer = new Set<number>();
  if (count("<", 0) === 1)
    outer.add(place.findIndex((line) => line.kind === "<"));
  if (count(">", eq - first + 1) === 1)
    outer.add(place.map((line) => line.kind).lastIndexOf(">"));

  const edit: ConflictText[] = [];
  let run = -1;
  for (let index = 0; index <= place.length; index++) {
    if (index < place.length && place[index].kind === null) {
      if (run < 0) run = index;
      continue;
    }
    if (run >= 0)
      edit.push({
        text: body.slice(place[run].start, place[index - 1].contentEnd),
        marker: false,
      });
    run = -1;
    if (index < place.length && !outer.has(index))
      edit.push({ text: text(place[index]), marker: true });
  }
  return {
    lines: place.map((line) => ({
      text: text(line),
      marker: line.kind !== null,
    })),
    edit,
  };
}
