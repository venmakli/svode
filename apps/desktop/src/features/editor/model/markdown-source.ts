import { htmlToJsx, type DeserializeMdOptions } from "@platejs/markdown";

/**
 * Source-aware view of the Markdown that Plate parses.
 *
 * Plate rewrites the text it is given (`htmlToJsx`) before parsing it in the
 * Svode dialect (GFM + MDX), so node positions and values describe the
 * rewritten text. This module maps parse positions back to the original source
 * so editor rules can keep source characters exactly instead of trusting the
 * rewritten values.
 */

export interface MdastPoint {
  line: number;
  column: number;
  offset?: number;
}

export interface MdastNode {
  type: string;
  value?: string;
  label?: string | null;
  children?: MdastNode[];
  data?: Record<string, unknown>;
  position?: { start: MdastPoint; end: MdastPoint };
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface EditSegment {
  outStart: number;
  outEnd: number;
  inStart: number;
  inEnd: number;
}

/** Text produced from an input by replacements, with offsets back to the input. */
export interface MappedText {
  text: string;
  toInput(offset: number): number;
}

export function applyTextEdits(input: string, edits: TextEdit[]): MappedText {
  const segments: EditSegment[] = [];
  let text = "";
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor) continue;
    text += input.slice(cursor, edit.start);
    segments.push({
      outStart: text.length,
      outEnd: text.length + edit.text.length,
      inStart: edit.start,
      inEnd: edit.end,
    });
    text += edit.text;
    cursor = edit.end;
  }
  text += input.slice(cursor);

  return {
    text,
    toInput(offset) {
      let shift = 0;
      for (const segment of segments) {
        if (offset < segment.outStart) break;
        if (offset < segment.outEnd) {
          return (
            segment.inStart +
            Math.min(offset - segment.outStart, segment.inEnd - segment.inStart)
          );
        }
        shift = segment.inEnd - segment.outEnd;
      }
      return offset + shift;
    },
  };
}

export function composeMappedText(...stages: MappedText[]): MappedText {
  return {
    text: stages.at(-1)?.text ?? "",
    toInput: (offset) =>
      stages.reduceRight((current, stage) => stage.toInput(current), offset),
  };
}

export const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;
const HTML_TAG_RE = /<([a-zA-Z0-9]+)\b([^>]*?)(\/?)>/gi;

function regexEdits(
  input: string,
  pattern: RegExp,
  edit: (match: RegExpExecArray) => TextEdit[],
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const match of input.matchAll(new RegExp(pattern))) {
    edits.push(...edit(match as RegExpExecArray));
  }
  return edits;
}

/**
 * Replays Plate's `htmlToJsx` with offset tracking. Returns null when the
 * replay differs from the installed Plate version, so callers fall back to
 * Plate's own behaviour instead of using wrong offsets.
 */
export function mapHtmlToJsx(input: string): MappedText | null {
  const comments = applyTextEdits(
    input,
    regexEdits(input, HTML_COMMENT_RE, (match) => {
      const end = match.index + match[0].length;
      return [
        { start: match.index, end: match.index + 4, text: "{/*" },
        { start: end - 3, end, text: "*/}" },
      ];
    }),
  );
  const tags = applyTextEdits(
    comments.text,
    regexEdits(comments.text, HTML_TAG_RE, (match) => [
      {
        start: match.index,
        end: match.index + match[0].length,
        text: htmlToJsx(match[0]),
      },
    ]),
  );
  const mapped = composeMappedText(comments, tags);
  return mapped.text === htmlToJsx(input) ? mapped : null;
}

export interface MarkdownSourceRange {
  start: number;
  end: number;
}

/** Plate parse positions resolved against the original Markdown source. */
export interface MarkdownSourceView {
  source: string;
  range(node: MdastNode): MarkdownSourceRange | null;
  /**
   * Source text of `range` with the prefixes of the block containers in
   * `ancestors` removed from every line that starts inside it.
   */
  text(range: MarkdownSourceRange, ancestors: MdastNode[]): string;
  /**
   * Source text of the node with the prefixes of its block containers removed
   * from continuation lines: the text a container serializer indents again.
   */
  innerText(node: MdastNode, ancestors: MdastNode[]): string | null;
  /** The same view of the text Plate parsed, which node values come from. */
  parsed: MarkdownSourceView;
}

const BLOCKQUOTE_PREFIX_RE = /^ {0,3}>[ \t]?/;
const LIST_MARKER_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])/;

function lineStartOf(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function stripIndent(line: string, width: number): number {
  let index = 0;
  let column = 0;
  while (index < line.length && column < width) {
    if (line[index] === " ") column += 1;
    else if (line[index] === "\t") column += 4 - (column % 4);
    else break;
    index += 1;
  }
  return index;
}

function textView(
  source: string,
  toSource: (offset: number) => number,
): Omit<MarkdownSourceView, "parsed"> {
  const sourceOf = (point: MdastPoint | undefined) =>
    point?.offset === undefined ? null : toSource(point.offset);

  const range = (node: MdastNode): MarkdownSourceRange | null => {
    const start = sourceOf(node.position?.start);
    const end = sourceOf(node.position?.end);
    return start === null || end === null ? null : { start, end };
  };

  // Length of the container prefixes at the start of the line beginning at
  // `lineStart`, for the containers in `chain` (outermost first).
  const prefixLength = (lineStart: number, chain: MdastNode[]): number => {
    let consumed = 0;
    const lineEnd = source.indexOf("\n", lineStart);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    for (const [index, container] of chain.entries()) {
      const rest = line.slice(consumed);
      if (container.type === "blockquote") {
        const marker = BLOCKQUOTE_PREFIX_RE.exec(rest);
        if (!marker) return consumed;
        consumed += marker[0].length;
      } else if (container.type === "listItem") {
        consumed += stripIndent(
          rest,
          listContentWidth(container, chain.slice(0, index)),
        );
      }
    }
    return consumed;
  };

  const listContentWidth = (item: MdastNode, outer: MdastNode[]): number => {
    const itemRange = range(item);
    if (!itemRange) return 0;
    const itemLineStart = lineStartOf(source, itemRange.start);
    const contentStart = itemLineStart + prefixLength(itemLineStart, outer);
    const first = item.children?.[0];
    const firstRange = first ? range(first) : null;
    if (firstRange && lineStartOf(source, firstRange.start) === itemLineStart) {
      return firstRange.start - contentStart;
    }
    const marker = LIST_MARKER_RE.exec(
      source.slice(contentStart, contentStart + 16),
    );
    return (marker?.[0].length ?? 0) + 1;
  };

  const text = (
    { start, end }: MarkdownSourceRange,
    ancestors: MdastNode[],
  ): string => {
    const chain = ancestors.filter(
      (ancestor) =>
        ancestor.type === "blockquote" || ancestor.type === "listItem",
    );
    const lines = source.slice(start, end).split("\n");
    let lineStart = start;
    return lines
      .map((line, index) => {
        const current = lineStart;
        lineStart += line.length + 1;
        if (chain.length === 0) return line;
        if (index === 0 && lineStartOf(source, current) !== current) {
          return line;
        }
        return line.slice(Math.min(prefixLength(current, chain), line.length));
      })
      .join("\n");
  };

  return {
    source,
    range,
    text,
    innerText(node, ancestors) {
      const nodeRange = range(node);
      return nodeRange ? text(nodeRange, ancestors) : null;
    },
  };
}

export function createMarkdownSourceView(
  source: string,
  parsed: MappedText,
): MarkdownSourceView {
  const parsedView = textView(
    parsed.text,
    (offset) => offset,
  ) as MarkdownSourceView;
  parsedView.parsed = parsedView;
  return { ...textView(source, parsed.toInput), parsed: parsedView };
}

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];

export type MarkdownSourceAnnotator = (
  node: MdastNode,
  ancestors: MdastNode[],
  view: MarkdownSourceView,
) => void;

function visit(
  node: MdastNode,
  ancestors: MdastNode[],
  annotate: (node: MdastNode, ancestors: MdastNode[]) => void,
) {
  annotate(node, ancestors);
  const path = [...ancestors, node];
  for (const child of node.children ?? []) visit(child, path, annotate);
}

/**
 * Remark transformer that runs `annotators` over Plate's own parse of the
 * boundary text, with positions resolved against `source`. It does nothing on
 * parses of other text, such as Plate's fallback parses of document parts.
 */
export function markdownSourcePlugin(
  source: string,
  plateInput: MappedText,
  annotators: MarkdownSourceAnnotator[],
): RemarkPlugin {
  const parsed = mapHtmlToJsx(plateInput.text);
  const plugin = () => (tree: MdastNode, file: { value?: unknown }) => {
    if (!parsed || String(file.value) !== parsed.text) return;
    const view = createMarkdownSourceView(
      source,
      composeMappedText(plateInput, parsed),
    );
    visit(tree, [], (node, ancestors) => {
      for (const annotate of annotators) annotate(node, ancestors, view);
    });
  };
  return plugin as unknown as RemarkPlugin;
}
