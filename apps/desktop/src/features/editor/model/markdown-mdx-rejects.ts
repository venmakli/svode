import { markdownToAstProcessor } from "@platejs/markdown";
import type { SlateEditor } from "platejs";

import {
  applyTextEdits,
  mapHtmlToJsx,
  type MappedText,
  type TextEdit,
} from "./markdown-source";

/**
 * Text MDX rejects where CommonMark reads text: a `<` that opens no tag or
 * comment (`a<b`, `x <= y`, `I <3`, an unclosed `<!--`), a tag without its
 * pair (`text <div> more`) and a `{` without its `}`. The place an MDX parse
 * stops at is neutralized in the text Plate parses, `<` as `&lt;` and `{` as
 * `\{`, which read as the character itself, so the rest of the document keeps
 * its MDX. `&lt;` rather than `\<` leaves a tag after it alone in `htmlToJsx`.
 */

interface MdxMessage {
  source?: string;
  reason?: string;
  place?: { offset?: number; start?: { offset?: number } };
}

// The open tag `mdast-util-mdx-jsx` reports unclosed, by line and column of
// the parsed text; its place, when there is one, is the container's.
const UNCLOSED_TAG_RE = /^Expected a closing tag for `[^`]*` \((\d+):(\d+)-/;
const TAB_SIZE = 4;

// Offset of a micromark point given by line and column, which count a tab to
// the next tab stop.
function offsetAt(text: string, line: number, column: number): number | null {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const end = text.indexOf("\n", start);
    if (end === -1) return null;
    start = end + 1;
  }
  let current = 1;
  for (let offset = start; offset < text.length; offset += 1) {
    if (current === column) return offset;
    if (current > column || text[offset] === "\n") return null;
    current +=
      text[offset] === "\t" ? TAB_SIZE - ((current - 1) % TAB_SIZE) : 1;
  }
  return null;
}

function isEscaped(text: string, offset: number): boolean {
  let backslashes = 0;
  while (text[offset - backslashes - 1] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

function lessThanBefore(text: string, from: number): number | null {
  for (let offset = from; offset >= 0; offset -= 1) {
    if (text[offset] === "<" && !isEscaped(text, offset)) return offset;
  }
  return null;
}

function unmatchedBraceBefore(text: string, from: number): number | null {
  let depth = 0;
  for (let offset = from; offset >= 0; offset -= 1) {
    const character = text[offset];
    if ((character !== "{" && character !== "}") || isEscaped(text, offset)) {
      continue;
    }
    if (character === "}") depth += 1;
    else if (depth === 0) return offset;
    else depth -= 1;
  }
  return null;
}

function endsBlankLine(text: string, lineEnd: number): boolean {
  let offset = lineEnd - 1;
  while (text[offset] === " " || text[offset] === "\t") offset -= 1;
  return offset < 0 || text[offset] === "\n";
}

/**
 * The `<` of the tag a `{` is an attribute expression of. Text is read from
 * the start, so a `<` before the `{` in its paragraph that opens a tag either
 * closed it with `>` or starts the tag still being read.
 */
function tagOf(text: string, brace: number): number | null {
  for (let offset = brace - 1; offset >= 0; offset -= 1) {
    const character = text[offset];
    if (character === ">") return null;
    if (character === "\n" && endsBlankLine(text, offset)) return null;
    if (
      character === "<" &&
      !isEscaped(text, offset) &&
      !/\s/.test(text[offset + 1] ?? " ")
    ) {
      return offset;
    }
  }
  return null;
}

/** Offset in `parsed` of the `<` or `{` an MDX parse error of it stops at. */
function rejectedOpener(parsed: string, error: unknown): number | null {
  const { source, reason, place } = (error ?? {}) as MdxMessage;
  const point = place?.start?.offset ?? place?.offset;
  switch (source) {
    case "micromark-extension-mdx-jsx":
      // The tag being read starts before the character it stops at.
      return point === undefined ? null : lessThanBefore(parsed, point - 1);
    case "micromark-extension-mdx-expression": {
      const brace =
        point === undefined ? null : unmatchedBraceBefore(parsed, point - 1);
      return brace === null ? null : (tagOf(parsed, brace) ?? brace);
    }
    case "mdast-util-mdx-jsx": {
      const open = UNCLOSED_TAG_RE.exec(reason ?? "");
      if (open) return offsetAt(parsed, Number(open[1]), Number(open[2]));
      // A closing tag or slash no open tag pairs with.
      return point === undefined ? null : lessThanBefore(parsed, point);
    }
    default:
      return null;
  }
}

function rejectEdit(
  text: string,
  jsx: MappedText,
  error: unknown,
): TextEdit | null {
  const opener = rejectedOpener(jsx.text, error);
  if (opener === null) return null;
  const offset = jsx.toInput(opener);
  if (text[offset] === "<") {
    return { start: offset, end: offset + 1, text: "&lt;" };
  }
  if (text[offset] === "{") return { start: offset, end: offset, text: "\\" };
  return null;
}

/**
 * The edit of `text` that neutralizes the place `error`, an error of the MDX
 * parse of `text` after `htmlToJsx`, stops at, or null when the error is not
 * one of such a place.
 */
export function mdxRejectEdit(text: string, error: unknown): TextEdit | null {
  const jsx = mapHtmlToJsx(text);
  return jsx ? rejectEdit(text, jsx, error) : null;
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const CLOSING_FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const BLANK_LINE_RE = /^[ \t]*$/;

/** The parts of `text` between blank lines outside fenced code. */
function blankLineParts(text: string): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let partStart = -1;
  let fence: string | null = null;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const start = lineStart;
    lineStart += line.length + 1;
    if (!fence && BLANK_LINE_RE.test(line)) {
      if (partStart !== -1) parts.push({ start: partStart, end: start });
      partStart = -1;
      continue;
    }
    if (partStart === -1) partStart = start;
    if (fence) {
      const closing = CLOSING_FENCE_RE.exec(line)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length) {
        fence = null;
      }
    } else {
      fence = FENCE_RE.exec(line)?.[1] ?? null;
    }
  }
  if (partStart !== -1) parts.push({ start: partStart, end: text.length });
  return parts;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Fenced code and code spans, which MDX reads without JSX or expressions.
const CODE_RE = /^[ \t]*(`{3,}|~{3,})[^]*?^[ \t]*\1[ \t]*$|(`+)[^`]*?\2/gm;
// A link or definition destination in `<…>`, which is no JSX.
const DESTINATION = String.raw`(?<=\]\(\s*|\]:\s*)<[^<>\n]*>`;
const ACCEPTED_AT_LESS_THAN_RE = new RegExp(
  `${DESTINATION}|${
    /<(?:\s|$)|<!--[\s\S]*?-->|<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|<[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9.-]+>|<(\/?)([A-Za-z][\w.:-]*)(?:\s[^<>{}]*?)?(\/?)>/
      .source
  }`,
  "y",
);

/**
 * Whether MDX accepts every `<` of `text` by its look alone, code left out:
 * before whitespace, a destination, a closed comment, an autolink or a tag,
 * with the tags paired, and no `{`. A part that looks accepted is not parsed alone; a place
 * this misses is found by the parse of the whole text.
 */
function looksAccepted(text: string): boolean {
  const prose = text.replace(CODE_RE, "");
  if (prose.includes("{")) return false;
  const open: string[] = [];
  for (let offset = prose.indexOf("<"); offset !== -1; ) {
    if (!isEscaped(prose, offset)) {
      ACCEPTED_AT_LESS_THAN_RE.lastIndex = offset;
      const match = ACCEPTED_AT_LESS_THAN_RE.exec(prose);
      if (!match) return false;
      const [, closing, name, selfClosing] = match;
      if (name && closing) {
        if (open.pop() !== name) return false;
      } else if (
        name &&
        !selfClosing &&
        !VOID_ELEMENTS.has(name.toLowerCase())
      ) {
        open.push(name);
      }
    }
    offset = prose.indexOf("<", offset + 1);
  }
  return open.length === 0;
}

// Code, destinations, comments and tags, where a `<` is not paragraph text.
const LITERAL_SPAN_RE = new RegExp(
  `${CODE_RE.source}|${DESTINATION}|<!--[\\s\\S]*?-->|<[A-Za-z/][^<>]*>`,
  "gm",
);
// A `<` before a character no tag, comment or autolink can start with.
const BARE_LESS_THAN_RE =
  /<(?![\p{ID_Start}$_/>!\s]|[\w.!#$%&'*+/=?^`{|}~-]+@)/uy;

/**
 * The edits neutralizing each `<` of `text` that MDX stops at by its look
 * alone (`<=`, `<3`), outside code, destinations, comments and tags, so the
 * parse is left the places that need it.
 */
function bareLessThanEdits(text: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const scan = (from: number, to: number) => {
    for (let offset = text.indexOf("<", from); offset !== -1; ) {
      if (offset >= to) return;
      BARE_LESS_THAN_RE.lastIndex = offset;
      if (!isEscaped(text, offset) && BARE_LESS_THAN_RE.test(text)) {
        edits.push({ start: offset, end: offset + 1, text: "&lt;" });
      }
      offset = text.indexOf("<", offset + 1);
    }
  };
  let cursor = 0;
  for (const span of text.matchAll(LITERAL_SPAN_RE)) {
    scan(cursor, span.index);
    cursor = span.index + span[0].length;
  }
  scan(cursor, text.length);
  return edits;
}

const LINE_PREFIX_RE =
  /^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)))*[ \t]*$/;

/**
 * Whether the neutralized place may be closed after a blank line in the whole
 * text, where the parse of its part alone cannot see it: an element of the
 * flow without its pair in the part, a `<!--` and a `{` that start a line
 * after its container markers.
 */
function mayCloseLater(text: string, offset: number, error: unknown): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  if (!LINE_PREFIX_RE.test(text.slice(lineStart, offset))) return false;
  return (
    text[offset] === "{" ||
    text[offset + 1] === "!" ||
    (error as MdxMessage | null)?.source === "mdast-util-mdx-jsx"
  );
}

/**
 * The edits neutralizing the places MDX rejects inside the lines of `text`,
 * found by parsing only the part between blank lines each is in: such a place
 * does not depend on the rest of the document, and a short part parses fast
 * however many places the document has. A place that may be closed in another
 * part is left to the parse of the whole text.
 */
export function localMdxRejectEdits(
  editor: SlateEditor,
  text: string,
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const part of blankLineParts(text)) {
    const partText = text.slice(part.start, part.end);
    if (looksAccepted(partText)) continue;
    const local = bareLessThanEdits(partText);
    for (;;) {
      const current = applyTextEdits(partText, local);
      if (looksAccepted(current.text)) break;
      const jsx = mapHtmlToJsx(current.text);
      if (!jsx) break;
      let error: unknown;
      try {
        markdownToAstProcessor(editor, jsx.text);
        break;
      } catch (caught) {
        error = caught;
      }
      const edit = rejectEdit(current.text, jsx, error);
      if (!edit || mayCloseLater(current.text, edit.start, error)) break;
      const start = current.toInput(edit.start);
      if (local.some((known) => known.start === start)) break;
      local.push({
        start,
        end: start + edit.end - edit.start,
        text: edit.text,
      });
    }
    for (const edit of local) {
      edits.push({
        start: part.start + edit.start,
        end: part.start + edit.end,
        text: edit.text,
      });
    }
  }
  return edits;
}
