import {
  type DeserializeMdOptions,
  defaultRules,
  type MdRules,
} from "@platejs/markdown";
import {
  type Descendant,
  ElementApi,
  getPluginType,
  KEYS,
  type SlateEditor,
  type TText,
  TextApi,
} from "platejs";

import type { MdastNode } from "./markdown-source";

/**
 * A line ending inside a paragraph is a soft line break; `\`, two spaces or
 * `<br>` before it make a hard one. Plate keeps both as "\n" in the text and
 * writes every "\n" as a hard break. A soft line break of the file is kept as
 * a text of its own that carries this mark, and is written as a line ending.
 */
export const SOFT_LINE_BREAK = "softLineBreak";

export function isSoftLineBreak(node: unknown): boolean {
  return (
    TextApi.isText(node) &&
    (node as Record<string, unknown>)[SOFT_LINE_BREAK] === true
  );
}

function withSoftLineBreaks(leaf: TText): TText[] {
  if (!leaf.text.includes("\n")) return [leaf];
  return leaf.text
    .split("\n")
    .flatMap((part, index) => [
      ...(index > 0 ? [{ ...leaf, text: "\n", [SOFT_LINE_BREAK]: true }] : []),
      ...(part ? [{ ...leaf, text: part }] : []),
    ]);
}

const inlineCode = defaultRules.code!;

// Plate's `text` rule also drops a line ending at the start of every text,
// which joins the lines around a link or emphasis; `remarkBreakLineEndings`
// drops only the one a `<br>` already stands for. Plate takes several nodes
// from any deserializer, though the rule types name one.
export const markdownLineBreakRules: MdRules = {
  text: {
    deserialize: (mdastNode, deco) =>
      withSoftLineBreaks({
        ...deco,
        text: mdastNode.value,
      }) as unknown as TText,
  },
  code: {
    ...inlineCode,
    deserialize: (...args) =>
      [inlineCode.deserialize!(...args)]
        .flat()
        .flatMap(withSoftLineBreaks) as unknown as ReturnType<
        NonNullable<typeof inlineCode.deserialize>
      >,
  },
};

const BR_HTML_RE = /^<br\s*\/?>$/i;

function endsWithBr(node: MdastNode): boolean {
  if (node.type === "mdxJsxTextElement" && "name" in node) {
    return node.name === "br";
  }
  if (node.type === "html") return BR_HTML_RE.test(node.value ?? "");
  const last = node.children?.at(-1);
  return !!last && endsWithBr(last);
}

function dropLineEndingsAfterBr(node: MdastNode) {
  const children = node.children ?? [];
  children.forEach((child, index) => {
    if (
      index > 0 &&
      child.type === "text" &&
      child.value?.startsWith("\n") &&
      endsWithBr(children[index - 1])
    ) {
      child.value = child.value.slice(1);
    }
    dropLineEndingsAfterBr(child);
  });
}

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];

/** A `<br>` and the line ending after it are one hard line break. */
export const remarkBreakLineEndings = function () {
  return dropLineEndingsAfterBr;
} as unknown as RemarkPlugin;

function isEmptyText(node: Descendant | undefined): boolean {
  return TextApi.isText(node) && node.text === "";
}

function hasLineContent(node: Descendant | undefined): boolean {
  return !!node && (!TextApi.isText(node) || /[^\n]/.test(node.text));
}

/**
 * A soft line break stays soft only after line content and before more of
 * it: one at the edge of the paragraph or right after another line break
 * has no Markdown form of its own, and is written as Plate writes a line
 * break.
 */
export function withEdgeSoftLineBreaksHard(
  children: Descendant[],
): Descendant[] {
  return children.map((child, index) => {
    if (!isSoftLineBreak(child)) return child;
    let before = index - 1;
    while (isEmptyText(children[before])) before -= 1;
    if (
      (child as TText).text === "\n" &&
      hasLineContent(children[before]) &&
      !(children[before] as TText).text?.endsWith("\n") &&
      children.slice(index + 1).some(hasLineContent)
    ) {
      return child;
    }
    const { [SOFT_LINE_BREAK]: _soft, ...hard } = child as TText;
    return hard as TText;
  });
}

export const LINE_BREAK_TYPE = "break";

function lineBreak(): Descendant {
  return { type: LINE_BREAK_TYPE, children: [{ text: "" }] } as Descendant;
}

/**
 * The children with every hard line break as a `break` node, which Plate
 * writes as `\` and a line ending; soft line breaks stay text. With
 * `interiorOnly`, a line break before all line content or after it stays
 * text.
 */
export function withHardLineBreakNodes(
  children: Descendant[],
  interiorOnly = false,
): Descendant[] {
  const first = children.findIndex(hasLineContent);
  let last = children.length - 1;
  while (last >= 0 && !hasLineContent(children[last])) last -= 1;

  return children.flatMap((child, index) => {
    if (
      !TextApi.isText(child) ||
      isSoftLineBreak(child) ||
      !child.text.includes("\n")
    ) {
      return [child];
    }
    const parts = child.text.split("\n");
    return parts.flatMap((part, partIndex) => {
      const nodes: Descendant[] = [];
      if (partIndex > 0) {
        const interior =
          (index > first ||
            parts.slice(0, partIndex).some((before) => before !== "")) &&
          (index < last ||
            parts.slice(partIndex).some((after) => after !== ""));
        nodes.push(
          !interiorOnly || interior ? lineBreak() : { ...child, text: "\n" },
        );
      }
      if (part) nodes.push({ ...child, text: part });
      return nodes;
    });
  });
}

/**
 * Plate's list serializer writes the texts of a list paragraph without the
 * paragraph rule, so every line break would be soft. Hard line breaks inside
 * the item are passed to it as `break` nodes.
 */
export function withListLineBreaks(
  editor: SlateEditor,
  nodes: Descendant[],
): Descendant[] {
  const paragraphType = getPluginType(editor, KEYS.p);
  let changed = false;

  const result = nodes.map((node) => {
    if (!ElementApi.isElement(node)) return node;
    const children =
      node.type === paragraphType && "listStyleType" in node
        ? withHardLineBreakNodes(
            withEdgeSoftLineBreaksHard(node.children),
            true,
          )
        : withListLineBreaks(editor, node.children);
    if (
      children.length === node.children.length &&
      children.every((child, index) => child === node.children[index])
    ) {
      return node;
    }
    changed = true;
    return { ...node, children } as Descendant;
  });

  return changed ? result : nodes;
}
