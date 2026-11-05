import {
  type AmbiguousConflict,
  ambiguousConflictText,
  type ConflictBlock,
  findConflictBlocks,
  type TextRange,
} from "./conflict-markers";

/**
 * A conflict place of the editor (DF-303 R1–R2): the lines of one or more
 * blocks of Git and the lines around them that keep every fenced code block
 * whole on one side of its edges. Its sides and base, or its lines when one
 * of its blocks is ambiguous.
 */
export type ConflictPlace = TextRange &
  (
    | {
        /** The place with each block replaced by its side, without the ending of its last line. */
        ours: string;
        theirs: string;
        /** The same with the base of each block, `null` unless every block has one. */
        base: string | null;
        ambiguous: null;
      }
    | { ambiguous: AmbiguousConflict }
  );

/** The fenced code blocks of a Markdown text as Markdown IO reads it. */
export type FencedCodeRanges = (markdown: string) => readonly TextRange[];

type ClearBlock = Extract<ConflictBlock, { ambiguous: null }>;

interface PlaceLines extends TextRange {
  /** Indexes of the blocks of the place, in order. */
  blocks: number[];
}

/**
 * The conflict places of `body` with markers of `size`, in document order.
 * `bases[i]` is the base of the block `i`. A place grows from its blocks until
 * no fenced code block of either version of the file — each block replaced by
 * one side, an ambiguous block as the file holds it — nor, for a place with an
 * ambiguous block, of the file as it is, crosses its edges; places that meet
 * become one.
 */
export function findConflictPlaces(
  body: string,
  size: number,
  bases: readonly (string | null)[],
  fencedCode: FencedCodeRanges,
): ConflictPlace[] {
  const blocks = findConflictBlocks(body, size);
  if (blocks.length === 0) return [];

  const lineStart = (offset: number) => body.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = (offset: number) => {
    const newline = body.indexOf("\n", offset);
    return newline === -1 ? body.length : newline + 1;
  };
  const wholeLines = ({ start, end }: TextRange): TextRange => ({
    start: lineStart(start),
    end: lineEnd(Math.max(start, end - 1)),
  });
  const versionCode = [
    versionCodeRanges(body, blocks, "oursLines", fencedCode),
    versionCodeRanges(body, blocks, "theirsLines", fencedCode),
  ]
    .flat()
    .map(wholeLines);
  const fileCode = blocks.some((block) => block.ambiguous)
    ? fencedCode(body).map(wholeLines)
    : [];

  const crosses = (code: TextRange, place: TextRange) =>
    code.start < place.end &&
    code.end > place.start &&
    (code.start < place.start || code.end > place.end);
  let places: PlaceLines[] = blocks.map((block, index) => ({
    start: block.start,
    end: block.end,
    blocks: [index],
  }));
  for (let changed = true; changed; ) {
    changed = false;
    for (const place of places) {
      const ambiguous = place.blocks.some((index) => blocks[index].ambiguous);
      for (const code of ambiguous
        ? [...versionCode, ...fileCode]
        : versionCode)
        if (crosses(code, place)) {
          place.start = Math.min(place.start, code.start);
          place.end = Math.max(place.end, code.end);
          changed = true;
        }
    }
    const merged: PlaceLines[] = [];
    for (const place of places) {
      const previous = merged.at(-1);
      if (previous && place.start < previous.end) {
        previous.end = Math.max(previous.end, place.end);
        previous.blocks.push(...place.blocks);
        changed = true;
      } else merged.push(place);
    }
    places = merged;
  }

  return places.map((place): ConflictPlace => {
    const range = { start: place.start, end: place.end };
    const inPlace = place.blocks.map((index) => blocks[index]);
    if (inPlace.some((block) => block.ambiguous))
      return {
        ...range,
        ambiguous: ambiguousConflictText(
          body,
          size,
          range,
          inPlace[0].separator,
        ),
      };
    const clear = inPlace as ClearBlock[];
    const side = (pick: (block: ClearBlock, index: number) => string) => {
      let text = "";
      let cursor = place.start;
      for (const [at, block] of clear.entries()) {
        text += body.slice(cursor, block.start) + pick(block, place.blocks[at]);
        cursor = block.end;
      }
      return withoutLastLineEnding(text + body.slice(cursor, place.end));
    };
    const lines = (lines: TextRange) => body.slice(lines.start, lines.end);
    return {
      ...range,
      ours: side((block) => lines(block.oursLines)),
      theirs: side((block) => lines(block.theirsLines)),
      base: place.blocks.every((index) => typeof bases[index] === "string")
        ? side((block, index) => {
            const base = bases[index] as string;
            return base && base + lineEndingBefore(body, block.end);
          })
        : null,
      ambiguous: null,
    };
  });
}

/**
 * The fenced code blocks of the version of `body` where each clear block is
 * replaced by the lines of one side, by offsets in `body`: code that starts or
 * ends in a side starts or ends with its block.
 */
function versionCodeRanges(
  body: string,
  blocks: ConflictBlock[],
  side: "oursLines" | "theirsLines",
  fencedCode: FencedCodeRanges,
): TextRange[] {
  // Pieces of the version: text of `body` as it is, or a side for its block.
  const pieces: { at: number; from: TextRange; replaced: boolean }[] = [];
  let version = "";
  let cursor = 0;
  const push = (text: string, from: TextRange, replaced: boolean) => {
    pieces.push({ at: version.length, from, replaced });
    version += text;
  };
  for (const block of blocks) {
    if (block.ambiguous) continue;
    push(
      body.slice(cursor, block.start),
      { start: cursor, end: block.start },
      false,
    );
    const lines = block[side];
    push(body.slice(lines.start, lines.end), block, true);
    cursor = block.end;
  }
  push(body.slice(cursor), { start: cursor, end: body.length }, false);

  // The text of `body` the character `offset` of the version stands for.
  const source = (offset: number): TextRange => {
    let piece = pieces[0];
    for (const next of pieces) {
      if (next.at > offset) break;
      piece = next;
    }
    if (piece.replaced) return piece.from;
    const at = piece.from.start + offset - piece.at;
    return { start: at, end: at + 1 };
  };
  return fencedCode(version).map(({ start, end }) => ({
    start: source(start).start,
    end: source(Math.max(start, end - 1)).end,
  }));
}

function lineEndingBefore(body: string, end: number): string {
  if (body[end - 1] !== "\n") return "";
  return body[end - 2] === "\r" ? "\r\n" : "\n";
}

function withoutLastLineEnding(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
