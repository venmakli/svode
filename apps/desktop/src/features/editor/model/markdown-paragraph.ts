import {
  convertNodesSerialize,
  type DeserializeMdOptions,
  defaultRules,
  getDeserializerByKey,
  type MdRules,
} from "@platejs/markdown";
import { type Descendant, type TElement, type TText, TextApi } from "platejs";

import {
  isSoftLineBreak,
  LINE_BREAK_TYPE,
  withEdgeSoftLineBreaksHard,
  withHardLineBreakNodes,
} from "./markdown-line-breaks";

/**
 * U+200B is how the Markdown keeps an empty paragraph. Plate writes every
 * empty text of a paragraph that way and reads every U+200B text back as
 * empty, but Slate keeps empty texts around inline elements: a link at the
 * edge of a paragraph would gain a character the file never had, and lose one
 * the file has. Only a paragraph without content is written as U+200B, and
 * only a paragraph of one U+200B is read as empty.
 */

const ZWSP = "\u200b";

const paragraph = defaultRules.p!;

function isEmptyText(node: Descendant): boolean {
  return TextApi.isText(node) && node.text === "";
}

function deserializeParagraph(
  ...[node, deco, options]: Parameters<
    NonNullable<typeof paragraph.deserialize>
  >
) {
  const zwspTexts = new WeakSet<TText>();
  const text = getDeserializerByKey("text", options);
  const tracking: DeserializeMdOptions = {
    ...options,
    rules: {
      ...options.rules,
      text: {
        deserialize: (...args) => {
          const leaves = [text(...args)].flat() as TText[];
          for (const leaf of leaves)
            if (leaf.text === ZWSP) zwspTexts.add(leaf);
          return leaves as unknown as TText;
        },
      },
    },
  };
  const result = paragraph.deserialize!(node, deco, tracking);
  for (const element of [result].flat() as TElement[]) {
    if (element.children.length === 1) continue;
    for (const child of element.children) {
      if (zwspTexts.has(child as TText)) child.text = ZWSP;
    }
  }
  return result;
}

type SerializeOptions = Parameters<NonNullable<typeof paragraph.serialize>>[1];
type MdastParagraph = ReturnType<NonNullable<typeof paragraph.serialize>>;

// Plate's paragraph serializer, except that a soft line break is written as
// a line ending instead of a `break`.
function serializeParagraph(node: TElement, options: SerializeOptions) {
  const children = node.children.every(isEmptyText)
    ? node.children
    : withEdgeSoftLineBreaksHard(node.children.filter((c) => !isEmptyText(c)));
  if (!children.some(isSoftLineBreak)) {
    return paragraph.serialize!({ ...node, children }, options);
  }
  const encoded = withHardLineBreakNodes(children);
  const converted = convertNodesSerialize(encoded, options);
  // A `\` ends no line at the end of a paragraph.
  if ((encoded.at(-1) as TElement).type === LINE_BREAK_TYPE) {
    converted[converted.length - 1] = {
      type: "html",
      value: "\n<br />",
    } as (typeof converted)[number];
  }
  return { type: "paragraph", children: converted } as MdastParagraph;
}

export const markdownParagraphRules: MdRules = {
  p: {
    deserialize: deserializeParagraph,
    serialize: serializeParagraph,
  },
};
