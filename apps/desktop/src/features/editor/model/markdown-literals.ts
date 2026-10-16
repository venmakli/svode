import type {
  MarkdownSourceAnnotator,
  MarkdownSourceView,
  MdastNode,
  TextEdit,
} from "./markdown-source";

/**
 * Code, math and escaped text are literal, but Plate's `htmlToJsx` rewrites
 * HTML in the whole text before parsing it. Code and math values are taken
 * from the source instead, and an escaped `<` reaches Plate in a form
 * `htmlToJsx` leaves alone, so they keep the characters of the file.
 */

const OPENING_FENCE_RE = /^( {0,3})(`{3,}|~{3,}|\${2,})/;
const INLINE_FENCE_RE = /^(`+|\$+)/;

function isClosingFence(line: string, fence: string): boolean {
  const closing = /^ {0,3}(`+|~+|\$+)[ \t]*$/.exec(line)?.[1];
  return !!closing && closing[0] === fence[0] && closing.length >= fence.length;
}

// Value of a fenced code or math block, as mdast-util-from-markdown reads it
// from the text of `view`.
function fencedValue(
  view: MarkdownSourceView,
  node: MdastNode,
  ancestors: MdastNode[],
): string | null {
  const range = view.range(node);
  if (!range) return null;
  const lineStart = view.source.lastIndexOf("\n", range.start - 1) + 1;
  // Lines at even indexes, each followed by its line ending.
  const parts = view
    .text({ start: lineStart, end: range.end }, ancestors)
    .split(/(\r\n|\n|\r)/);
  const opening = OPENING_FENCE_RE.exec(parts[0]);
  if (!opening) return null;
  const [, indent, fence] = opening;
  let content = parts.slice(2);
  const closed = content.length > 0 && isClosingFence(content.at(-1)!, fence);
  if (closed) content = content.slice(0, -2);
  const indentRe = new RegExp(`^ {0,${indent.length}}`);
  const value = content
    .map((part, index) => (index % 2 ? part : part.replace(indentRe, "")))
    .join("");
  return closed ? value : value.replace(/(\r\n|\n|\r)$/, "");
}

// Value of inline code or math, as mdast-util-from-markdown reads it from the
// text of `view`.
function inlineValue(
  view: MarkdownSourceView,
  node: MdastNode,
  ancestors: MdastNode[],
): string | null {
  const range = view.range(node);
  if (!range) return null;
  const raw = view.text(range, ancestors);
  const fence = INLINE_FENCE_RE.exec(raw)?.[0].length;
  if (!fence) return null;
  let content = raw.slice(fence, raw.length - fence);
  if (ancestors.some((ancestor) => ancestor.type === "tableCell")) {
    content = content.replaceAll("\\|", "|");
  }
  const padded =
    /^[ \n]/.test(content) && /[ \n]$/.test(content) && /[^ \n]/.test(content);
  return padded ? content.slice(1, -1) : content;
}

const LITERAL_VALUES: Record<string, typeof fencedValue> = {
  code: fencedValue,
  math: fencedValue,
  inlineCode: inlineValue,
  inlineMath: inlineValue,
};

/**
 * Restores the value of code and math from the source. The value is read the
 * same way from the text Plate parsed first: when that does not give Plate's
 * own value, the node is left as Plate made it.
 */
export const restoreMarkdownLiteral: MarkdownSourceAnnotator = (
  node,
  ancestors,
  view,
) => {
  const valueOf = LITERAL_VALUES[node.type];
  if (!valueOf || valueOf(view.parsed, node, ancestors) !== node.value) return;
  const value = valueOf(view, node, ancestors);
  if (value !== null) node.value = value;
};

const ESCAPED_OPENER_RE = /(\\+)<(?=!--|[a-zA-Z0-9])/g;

/**
 * An escaped `<` before a tag or comment opener is literal text, but
 * `htmlToJsx` would rewrite what follows it as HTML. The same character as a
 * character reference has the same value and is not rewritten. Inside code and
 * math the replacement is undone by `restoreMarkdownLiteral`.
 */
export function escapedOpenerEdits(markdown: string): TextEdit[] {
  return [...markdown.matchAll(ESCAPED_OPENER_RE)]
    .filter((match) => match[1].length % 2 === 1)
    .map((match) => {
      const start = match.index + match[1].length - 1;
      return { start, end: start + 2, text: "&lt;" };
    });
}
