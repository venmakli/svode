import {
  markdownToAstProcessor,
  type SerializeMdOptions,
} from "@platejs/markdown";
import type { SlateEditor } from "platejs";

import { markdownRootHandler } from "./markdown-comments";
import { readWithMdxOrWithout } from "./markdown-io";
import { mapHtmlToJsx, type MdastNode } from "./markdown-source";

/**
 * Minimal escaping of text characters on save.
 *
 * remark escapes a character of text whenever it could start markup at all
 * (`snake\_case`, `2 \* 3`, `AT\&T`). Svode writes a character of
 * `ESCAPABLE_CHARACTERS` with `\` only where the Svode reading of the written
 * text would otherwise differ: emphasis, strikethrough, inline code, a
 * character reference or a block at the start of a line.
 *
 * Inline markup never crosses a paragraph, heading or table cell, so the
 * decision is made per such inline container, inside the one stringify of the
 * document: the container is written once with its candidate characters
 * marked, its text is read back with different sets of escapes, and the
 * container is written again with the fewest escapes whose reading is that of
 * the text with all of them (see `decideEscapes`). Decisions are cached per
 * editor by the container text, so a save reads only the containers that
 * changed.
 */

type StringifyOptions = NonNullable<
  SerializeMdOptions["remarkStringifyOptions"]
>;
type Handlers = NonNullable<StringifyOptions["handlers"]>;
type Handle = NonNullable<Handlers["text"]>;
type State = Parameters<Handle>[2];
type Info = Parameters<Handle>[3];
type TextNode = { type: "text"; value: string };

const ESCAPABLE_CHARACTERS = new Set(["_", "*", "`", "&", "~", "@"]);

// A candidate is marked in the probe output by a punctuation sentinel, which
// attention flanking classifies like the `\` or the character written in its
// place, followed by a private-use character carrying the candidate id.
const SENTINEL = "\u2E2E";
const ID_BASE = 0xe000;
const ID_COUNT = 0xf8ff - ID_BASE + 1;
const MARKER_CHARACTERS_RE = /[\u2E2E\uE000-\uF8FF]/;

const ASCII_PUNCTUATION_RE = /[!-/:-@[-`{-~]/;
const CHARACTER_REFERENCE_RE =
  /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;
const ENCODED_CHARACTER_RE = /&#x([0-9A-Fa-f]+);/y;
const CACHE_LIMIT = 4000;

type ContainerMode =
  | { kind: "conservative" }
  | { kind: "probe" }
  | { kind: "write"; escapes: Set<number> };

interface EscapeRun {
  mode: ContainerMode | null;
  ids: Map<TextNode, number>;
  nextId: number;
}

const decisionCache = new WeakMap<SlateEditor, Map<string, number[]>>();

/**
 * Offsets in `written` of the characters of `value` that are candidates:
 * every escapable character, which `written` keeps bare. Null when `written`
 * is not `value` with escapes and character references only.
 */
function candidateOffsets(value: string, written: string): number[] | null {
  const offsets: number[] = [];
  let i = 0;
  let j = 0;
  while (i < written.length) {
    if (j < value.length && written[i] === value[j]) {
      if (ESCAPABLE_CHARACTERS.has(value[j])) offsets.push(i);
      i += 1;
      j += 1;
      continue;
    }
    if (written[i] === "\\") {
      i += 1;
      continue;
    }
    ENCODED_CHARACTER_RE.lastIndex = i;
    const encoded = ENCODED_CHARACTER_RE.exec(written);
    if (!encoded || j >= value.length) return null;
    i += encoded[0].length;
    j += Number.parseInt(encoded[1], 16) > 0xffff ? 2 : 1;
  }
  return j === value.length ? offsets : null;
}

function withMarks(
  written: string,
  offsets: number[],
  mark: (index: number) => string,
): string {
  let result = "";
  let cursor = 0;
  offsets.forEach((offset, index) => {
    result += written.slice(cursor, offset) + mark(index);
    cursor = offset;
  });
  return result + written.slice(cursor);
}

function hasCandidateText(node: MdastNode): boolean | "conservative" {
  let found = false;
  const visit = (current: MdastNode): boolean => {
    if (current.type === "text" && typeof current.value === "string") {
      if (MARKER_CHARACTERS_RE.test(current.value)) return true;
      for (const character of ESCAPABLE_CHARACTERS) {
        if (current.value.includes(character)) found = true;
      }
    }
    return (current.children ?? []).some(visit);
  };
  return visit(node) ? "conservative" : found;
}

interface Probe {
  text: string;
  /** Candidate offsets in `text`, in output order. */
  offsets: number[];
  ids: number[];
}

function readProbe(output: string, run: EscapeRun): Probe | null {
  let text = "";
  const offsets: number[] = [];
  const ids: number[] = [];
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== SENTINEL) {
      text += output[index];
      continue;
    }
    const id = output.charCodeAt(index + 1) - ID_BASE;
    if (
      id < 0 ||
      id >= run.nextId ||
      !ESCAPABLE_CHARACTERS.has(output[index + 2] ?? "")
    ) {
      return null;
    }
    offsets.push(text.length);
    ids.push(id);
    index += 1;
  }
  return new Set(ids).size === ids.length && ids.length === run.nextId
    ? { text, offsets, ids }
    : null;
}

function readWithoutMdx(editor: SlateEditor, text: string): MdastNode {
  return markdownToAstProcessor(editor, text, {
    withoutMdx: true,
  } as never) as MdastNode;
}

/** The parse of `text` as Svode reads it, with offsets into `text`. */
function readMarkdown(
  editor: SlateEditor,
  text: string,
): { tree: MdastNode; parsed: string; toInput(offset: number): number } {
  return readWithMdxOrWithout((withoutMdx) => {
    const jsx = withoutMdx ? null : mapHtmlToJsx(text);
    if (jsx) {
      return {
        tree: markdownToAstProcessor(editor, jsx.text) as MdastNode,
        parsed: jsx.text,
        toInput: jsx.toInput,
      };
    }
    return {
      tree: readWithoutMdx(editor, text),
      parsed: text,
      toInput: (offset: number) => offset,
    };
  });
}

const referenceCache = new Map<string, string | null>();

/** The character a character reference reads as, or null for text. */
function decodeReference(
  editor: SlateEditor,
  reference: string,
): string | null {
  let decoded = referenceCache.get(reference);
  if (decoded === undefined) {
    const value = readWithoutMdx(editor, reference).children?.[0]?.children?.[0]
      ?.value;
    decoded = typeof value === "string" && value !== reference ? value : null;
    referenceCache.set(reference, decoded);
  }
  return decoded;
}

/**
 * Offsets of `source` (the source of a text node) that read as the
 * characters of `value` themselves, into `literal`, and of those the ones
 * read through their escape, into `escaped`.
 */
function literalOffsets(
  editor: SlateEditor,
  source: string,
  value: string,
  start: number,
  literal: Set<number>,
  escaped: Set<number>,
) {
  let i = 0;
  let j = 0;
  while (i < source.length) {
    const character = source[i];
    if (
      character === "\\" &&
      ASCII_PUNCTUATION_RE.test(source[i + 1] ?? "") &&
      value[j] === source[i + 1]
    ) {
      literal.add(start + i + 1);
      escaped.add(start + i + 1);
      i += 2;
      j += 1;
      continue;
    }
    if (character === "&") {
      CHARACTER_REFERENCE_RE.lastIndex = i;
      const reference = CHARACTER_REFERENCE_RE.exec(source)?.[0];
      const decoded = reference ? decodeReference(editor, reference) : null;
      if (reference && decoded !== null && value.startsWith(decoded, j)) {
        i += reference.length;
        j += decoded.length;
        continue;
      }
    }
    if (j < value.length && character === value[j]) {
      literal.add(start + i);
      i += 1;
      j += 1;
      continue;
    }
    // Whitespace around a line ending is not part of the value.
    if (character !== " " && character !== "\t") return;
    i += 1;
  }
}

interface Reading {
  /** The parse without positions: equal shapes read as the same value. */
  shape: string;
  /** Offsets of the text that read as text characters. */
  literal: Set<number>;
  /** Offsets of `literal` read through the escape before them. */
  escaped: Set<number>;
}

const withoutPositions = (key: string, value: unknown) =>
  key === "position" ? undefined : value;

function readText(editor: SlateEditor, text: string): Reading {
  const { tree, parsed, toInput } = readMarkdown(editor, text);
  const literal = new Set<number>();
  const escaped = new Set<number>();
  const visit = (node: MdastNode, parent: MdastNode | null) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      node.type === "text" &&
      typeof node.value === "string" &&
      start !== undefined &&
      end !== undefined &&
      // The text of a literal autolink is its address.
      !(
        parent?.type === "link" &&
        parent.position?.start.offset === start &&
        parent.position?.end.offset === end
      )
    ) {
      const local = new Set<number>();
      const localEscaped = new Set<number>();
      literalOffsets(
        editor,
        parsed.slice(start, end),
        node.value,
        start,
        local,
        localEscaped,
      );
      for (const offset of local) literal.add(toInput(offset));
      for (const offset of localEscaped) escaped.add(toInput(offset));
    }
    for (const child of node.children ?? []) visit(child, node);
  };
  visit(tree, null);
  return { shape: JSON.stringify(tree, withoutPositions), literal, escaped };
}

const AUTOLINK_HINT_RE = /@|www\.|:\/\//i;
const PUNCTUATION_RE = /\p{P}|\p{S}/u;

function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    !/\s/.test(character) &&
    !PUNCTUATION_RE.test(character)
  );
}

function isSpace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

/**
 * Whether no candidate of `probe` can be markup by its neighbours alone: `_`
 * inside a word neither opens nor closes emphasis, `*` and `~` between spaces
 * are no delimiters and not at a line start, `&` that starts no character
 * reference is text. Text that may hold an autolink is always read.
 */
function isInert(probe: Probe): boolean {
  if (AUTOLINK_HINT_RE.test(probe.text)) return false;
  return probe.offsets.every((offset) => {
    const before = probe.text[offset - 1];
    const after = probe.text[offset + 1];
    switch (probe.text[offset]) {
      case "_":
        return isWordCharacter(before) && isWordCharacter(after);
      case "*":
      case "~":
        return isSpace(before) && isSpace(after);
      case "&":
        CHARACTER_REFERENCE_RE.lastIndex = offset;
        return !CHARACTER_REFERENCE_RE.test(probe.text);
      default:
        return false;
    }
  });
}

function containerFrame(container: MdastNode): {
  prefix: string;
  suffix: string;
} {
  if (container.type === "heading") {
    const depth = (container as MdastNode & { depth?: number }).depth ?? 1;
    return { prefix: `${"#".repeat(depth)} `, suffix: "" };
  }
  if (container.type === "tableCell") {
    return { prefix: "| ", suffix: " |\n| - |" };
  }
  return { prefix: "", suffix: "" };
}

/**
 * Indices of the candidates of `probe` to escape. The reading to keep is that
 * of the text with every candidate escaped whose escape reads as one (inside
 * a literal autolink `\` is part of the address). From the bare text, the first
 * candidate read as markup is escaped until the reading is the same; if
 * candidates still change it without being markup themselves (a `~` that
 * lengthens a strikethrough marker), the search starts from all escapes.
 * Escapes the reading does not need are then dropped, last first.
 */
function decideEscapes(
  editor: SlateEditor,
  container: MdastNode,
  probe: Probe,
): number[] {
  const { prefix, suffix } = containerFrame(container);

  const reads = new Map<
    string,
    { shape: string; literal: boolean[]; escaped: boolean[] }
  >();
  const read = (escaped: Set<number>) => {
    const key = [...escaped].sort((a, b) => a - b).join(",");
    let result = reads.get(key);
    if (!result) {
      let text = prefix;
      const positions: number[] = [];
      let cursor = 0;
      probe.offsets.forEach((offset, index) => {
        text += probe.text.slice(cursor, offset);
        if (escaped.has(index)) text += "\\";
        positions.push(text.length);
        cursor = offset;
      });
      text += probe.text.slice(cursor) + suffix;
      const reading = readText(editor, text);
      result = {
        shape: reading.shape,
        literal: positions.map((position) => reading.literal.has(position)),
        escaped: positions.map((position) => reading.escaped.has(position)),
      };
      reads.set(key, result);
    }
    return result;
  };

  let all = new Set(probe.offsets.map((_, index) => index));
  for (;;) {
    const { escaped } = read(all);
    const working = new Set([...all].filter((index) => escaped[index]));
    if (working.size === all.size) break;
    all = working;
  }
  const target = read(all).shape;

  let escaped = new Set<number>();
  let current = read(escaped);
  while (current.shape !== target) {
    const next = current.literal.findIndex(
      (isLiteral, index) => !isLiteral && !escaped.has(index),
    );
    if (next === -1) break;
    escaped.add(next);
    current = read(escaped);
  }
  if (current.shape !== target) escaped = new Set(all);

  for (const index of [...escaped].sort((a, b) => b - a)) {
    const trial = new Set(escaped);
    trial.delete(index);
    if (read(trial).shape === target) escaped = trial;
  }

  return [...escaped].sort((a, b) => a - b);
}

function cachedEscapes(
  editor: SlateEditor,
  container: MdastNode,
  probe: Probe,
): number[] {
  let cache = decisionCache.get(editor);
  if (!cache) {
    cache = new Map();
    decisionCache.set(editor, cache);
  }
  const { prefix, suffix } = containerFrame(container);
  const key = `${prefix}\u0000${suffix}\u0000${withMarks(
    probe.text,
    probe.offsets,
    () => SENTINEL,
  )}`;
  let escapes = cache.get(key);
  if (!escapes) {
    escapes = isInert(probe) ? [] : decideEscapes(editor, container, probe);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, escapes);
  }
  return escapes;
}

function writeText(
  node: TextNode,
  state: State,
  info: Info,
  run: EscapeRun,
): string {
  const mode = run.mode;
  if (!mode || mode.kind === "conservative") {
    return state.safe(node.value, info);
  }

  const unsafe = state.unsafe;
  state.unsafe = unsafe.filter(
    (pattern) => !ESCAPABLE_CHARACTERS.has(pattern.character),
  );
  let written: string;
  try {
    written = state.safe(node.value, info);
  } finally {
    state.unsafe = unsafe;
  }

  const offsets = candidateOffsets(node.value, written);
  if (!offsets) return state.safe(node.value, info);
  if (offsets.length === 0) return written;

  let base = run.ids.get(node);
  if (mode.kind === "probe") {
    if (base === undefined) {
      base = run.nextId;
      run.nextId += offsets.length;
      run.ids.set(node, base);
    }
    const first = base;
    return withMarks(
      written,
      offsets,
      (index) => SENTINEL + String.fromCharCode(ID_BASE + first + index),
    );
  }
  if (base === undefined) return state.safe(node.value, info);
  const first = base;
  return withMarks(written, offsets, (index) =>
    mode.escapes.has(first + index) ? "\\" : "",
  );
}

/**
 * Writes an inline container (a paragraph, heading, table cell or a root of
 * phrasing content) with the escapes its own reading needs.
 */
function writeInlineContainer(
  editor: SlateEditor,
  run: EscapeRun,
  container: MdastNode,
  write: () => string,
): string {
  const candidates = hasCandidateText(container);
  if (candidates !== true) {
    run.mode = { kind: "conservative" };
    return write();
  }

  run.ids = new Map();
  run.nextId = 0;
  run.mode = { kind: "probe" };
  const probe = readProbe(write(), run);
  if (!probe || run.nextId > ID_COUNT) {
    run.mode = { kind: "conservative" };
    return write();
  }

  const escapes = cachedEscapes(editor, container, probe);
  run.mode = {
    kind: "write",
    escapes: new Set(escapes.map((index) => probe.ids[index])),
  };
  return write();
}

/**
 * `remark-stringify` handlers that write text with minimal escaping. The root
 * handler routes every outermost phrasing container of the document through
 * `writeInlineContainer`; the text handler writes text as the container
 * decided.
 */
function minimalEscapeHandlers(editor: SlateEditor): Handlers {
  const run: EscapeRun = { mode: null, ids: new Map(), nextId: 0 };
  const prepared = new WeakSet<State>();

  const prepare = (state: State) => {
    if (prepared.has(state)) return;
    prepared.add(state);
    const containerPhrasing = state.containerPhrasing;
    let depth = 0;
    state.containerPhrasing = function (parent, info) {
      const write = () => {
        depth += 1;
        try {
          return containerPhrasing.call(state, parent, info);
        } finally {
          depth -= 1;
        }
      };
      if (depth > 0) return write();
      try {
        return writeInlineContainer(
          editor,
          run,
          parent as unknown as MdastNode,
          write,
        );
      } finally {
        run.mode = null;
      }
    };
  };

  return {
    root: (node, parent, state, info) => {
      prepare(state);
      return markdownRootHandler(
        node,
        parent,
        state as unknown as Parameters<typeof markdownRootHandler>[2],
        info,
      );
    },
    text: (node, _parent, state, info) =>
      writeText(node as TextNode, state, info, run),
  };
}

/** `remarkStringifyOptions` of `editor` with minimal escaping of text. */
export function withMinimalTextEscapes(
  editor: SlateEditor,
  options: StringifyOptions | null | undefined,
): StringifyOptions {
  return {
    ...options,
    handlers: { ...options?.handlers, ...minimalEscapeHandlers(editor) },
  };
}
