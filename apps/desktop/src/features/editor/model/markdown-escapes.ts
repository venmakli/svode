import {
  markdownToAstProcessor,
  type SerializeMdOptions,
} from "@platejs/markdown";
import {
  type Descendant,
  ElementApi,
  getPluginType,
  type SlateEditor,
} from "platejs";

import { markdownRootHandler } from "./markdown-comments";
import { readWithMdxOrWithout } from "./markdown-io";
import {
  createReferenceResolution,
  linkDefinitionsOf,
} from "./markdown-references";
import { mapHtmlToJsx, type MdastNode } from "./markdown-source";

/**
 * Minimal escaping of text characters on save.
 *
 * remark escapes a character of text whenever it could start markup at all
 * (`snake\_case`, `2 \* 3`, `AT\&T`). Svode writes a character of
 * `ESCAPABLE_CHARACTERS` with `\` only where the Svode reading of the written
 * text would otherwise differ: emphasis, strikethrough, inline code, a
 * character reference, a link, image, footnote call or reference by the
 * definitions of the document, a task marker or a block at the start of a
 * line.
 *
 * Inline markup never crosses a paragraph, heading or table cell, so the
 * decision is made per such inline container, inside the one stringify of the
 * document: the container is written once with its candidate characters
 * marked, its text is read back with different sets of escapes, and the
 * container is written again with the fewest escapes whose reading is that of
 * the text with all of them (see `decideEscapes`). The text is read with the
 * link and footnote labels the document defines, so a bracket is escaped where
 * the document would read a reference. Decisions are cached per editor by the
 * container text and what is read with it, so a save reads only the
 * containers that changed.
 */

type StringifyOptions = NonNullable<
  SerializeMdOptions["remarkStringifyOptions"]
>;
type Handlers = NonNullable<StringifyOptions["handlers"]>;
type Handle = NonNullable<Handlers["text"]>;
type State = Parameters<Handle>[2];
type Info = Parameters<Handle>[3];
type TextNode = { type: "text"; value: string };

// `(` is a candidate as remark escapes it after `]`, as part of a link.
const ESCAPABLE_CHARACTERS = new Set([
  "_",
  "*",
  "`",
  "&",
  "~",
  "@",
  "[",
  "]",
  "!",
  "(",
]);

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

/**
 * An inline container as written, to check against what it should read as.
 * `key` identifies the text `read` parses: the container in its frame.
 */
export interface WrittenContainer {
  text: string;
  key: string;
  /** The Svode reading of the container, with offsets into `text`. */
  read(): { tree: MdastNode; toWritten(offset: number): number };
}

/**
 * A check of an inline container after it is written with its escapes. It
 * returns true when it changed how the container's nodes are written, and the
 * container is written again, its escapes decided anew.
 */
export type WrittenContainerCheck = (
  editor: SlateEditor,
  container: MdastNode,
  written: WrittenContainer,
) => boolean;

interface EscapeRun {
  mode: ContainerMode | null;
  ids: Map<TextNode, number>;
  nextId: number;
  /** Definitions of the labels the document defines, to read text with. */
  definitions: string;
  /** The head paragraph of each list item, by whether the item is a task. */
  listHeads: WeakMap<MdastNode, boolean>;
  checks: WrittenContainerCheck[];
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
  return readWithMdxOrWithout(editor, text, (input, withoutMdx) => {
    const jsx = withoutMdx ? null : mapHtmlToJsx(input.text);
    if (jsx) {
      return {
        tree: markdownToAstProcessor(editor, jsx.text) as MdastNode,
        parsed: jsx.text,
        toInput: (offset: number) => input.toInput(jsx.toInput(offset)),
      };
    }
    return {
      tree: readWithoutMdx(editor, input.text),
      parsed: input.text,
      toInput: input.toInput,
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

const LINK_HINT_RE = /\](?:\(|:)/;

/**
 * Whether no candidate of `probe` can be markup by its neighbours alone: `_`
 * inside a word neither opens nor closes emphasis, `*` and `~` between spaces
 * are no delimiters and not at a line start, `&` that starts no character
 * reference is text. Brackets are text when the document defines no label,
 * no `](` or `]:` makes a link or definition and the text does not start a
 * list item with one; then `!` and `(` are text too, as are `!` before
 * anything but `[` and `(` after anything but `]`. Text that may hold an
 * autolink is always read.
 */
function isInert(probe: Probe, frame: ContainerFrame): boolean {
  if (AUTOLINK_HINT_RE.test(probe.text)) return false;
  const linkable =
    frame.defines ||
    LINK_HINT_RE.test(probe.text) ||
    (frame.prefix.startsWith("-") && probe.text.startsWith("["));
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
      case "[":
      case "]":
        return !linkable;
      case "!":
        return !linkable || after !== "[";
      case "(":
        return !linkable || before !== "]";
      default:
        return false;
    }
  });
}

interface ContainerFrame {
  /** Text before the container that reads it as what it is. */
  prefix: string;
  /** Text after it, ending with the definitions of the document. */
  suffix: string;
  /** Whether the document defines any label. */
  defines: boolean;
}

/**
 * How the text of `container` is read on its own as it reads in the document:
 * a heading after its marker, a table cell inside a table, the head paragraph
 * of a list item after a list marker (and the task marker of a task), each
 * followed by the definitions of the document.
 */
function containerFrame(container: MdastNode, run: EscapeRun): ContainerFrame {
  let prefix = "";
  let ownSuffix = "";
  if (container.type === "heading") {
    const depth = (container as MdastNode & { depth?: number }).depth ?? 1;
    prefix = `${"#".repeat(depth)} `;
  } else if (container.type === "tableCell") {
    prefix = "| ";
    ownSuffix = " |\n| - |";
  } else {
    const task = run.listHeads.get(container);
    if (task !== undefined) prefix = task ? "- [ ] " : "- ";
  }
  return {
    prefix,
    suffix: ownSuffix + run.definitions,
    defines: run.definitions !== "",
  };
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
  { prefix, suffix }: ContainerFrame,
  probe: Probe,
): number[] {
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
  run: EscapeRun,
  container: MdastNode,
  probe: Probe,
): number[] {
  let cache = decisionCache.get(editor);
  if (!cache) {
    cache = new Map();
    decisionCache.set(editor, cache);
  }
  const frame = containerFrame(container, run);
  const key = `${frame.prefix}\u0000${frame.suffix}\u0000${withMarks(
    probe.text,
    probe.offsets,
    () => SENTINEL,
  )}`;
  let escapes = cache.get(key);
  if (!escapes) {
    escapes = isInert(probe, frame) ? [] : decideEscapes(editor, frame, probe);
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

function writeWithEscapes(
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

  const escapes = cachedEscapes(editor, run, container, probe);
  run.mode = {
    kind: "write",
    escapes: new Set(escapes.map((index) => probe.ids[index])),
  };
  return write();
}

function writtenContainer(
  editor: SlateEditor,
  run: EscapeRun,
  container: MdastNode,
  text: string,
): WrittenContainer {
  const { prefix, suffix } = containerFrame(container, run);
  return {
    text,
    key: `${prefix}\u0000${text}\u0000${suffix}`,
    read() {
      const { tree, toInput } = readMarkdown(editor, prefix + text + suffix);
      return {
        tree,
        toWritten: (offset) => toInput(offset) - prefix.length,
      };
    },
  };
}

/**
 * Writes an inline container (a paragraph, heading, table cell or a root of
 * phrasing content) with the escapes its own reading needs, again after each
 * check that changed how its nodes are written.
 */
function writeInlineContainer(
  editor: SlateEditor,
  run: EscapeRun,
  container: MdastNode,
  write: () => string,
): string {
  for (;;) {
    const text = writeWithEscapes(editor, run, container, write);
    const written = writtenContainer(editor, run, container, text);
    const changed = run.checks.filter((check) =>
      check(editor, container, written),
    );
    if (changed.length === 0) return text;
  }
}

/**
 * `remark-stringify` handlers that write text with minimal escaping. The root
 * handler routes every outermost phrasing container of the document through
 * `writeInlineContainer`; the text handler writes text as the container
 * decided.
 */
function minimalEscapeHandlers(
  editor: SlateEditor,
  definitions: string,
  checks: WrittenContainerCheck[],
): Handlers {
  const run: EscapeRun = {
    mode: null,
    ids: new Map(),
    nextId: 0,
    definitions,
    listHeads: new WeakMap(),
    checks,
  };
  const prepared = new WeakSet<State>();

  const prepare = (state: State, root: MdastNode) => {
    if (prepared.has(state)) return;
    prepared.add(state);
    visit(root, (node) => {
      const [head] = node.children ?? [];
      if (node.type === "listItem" && head?.type === "paragraph") {
        const { checked } = node as MdastNode & { checked?: boolean | null };
        run.listHeads.set(head, typeof checked === "boolean");
      }
    });
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
      prepare(state, node as unknown as MdastNode);
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

function visit(node: MdastNode, callback: (node: MdastNode) => void) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

/**
 * Definitions of the link and footnote labels `value` defines, as text to read
 * a container with: a bracket reads as a reference or footnote call only by a
 * definition of its label in the read text.
 */
function definitionsOf(editor: SlateEditor, value: Descendant[]): string {
  const footnoteType = getPluginType(editor, "footnoteDefinition");
  const footnotes = new Set<string>();
  const walk = (nodes: Descendant[]) => {
    for (const node of nodes) {
      if (!ElementApi.isElement(node)) continue;
      if (node.type === footnoteType && typeof node.identifier === "string") {
        footnotes.add(node.identifier);
      }
      walk(node.children);
    }
  };
  walk(value);
  const links = createReferenceResolution(
    linkDefinitionsOf(editor, value),
  ).suffix;
  return [...footnotes].reduce(
    (text, identifier) => `${text}\n\n[^${identifier}]: x\n`,
    links,
  );
}

/**
 * `remarkStringifyOptions` of `editor` with minimal escaping of the text of
 * `value`, the value they write. `checks` run on every inline container as
 * written.
 */
export function withMinimalTextEscapes(
  editor: SlateEditor,
  options: StringifyOptions | null | undefined,
  value: Descendant[],
  checks: WrittenContainerCheck[] = [],
): StringifyOptions {
  return {
    ...options,
    handlers: {
      ...options?.handlers,
      ...minimalEscapeHandlers(editor, definitionsOf(editor, value), checks),
    },
  };
}
