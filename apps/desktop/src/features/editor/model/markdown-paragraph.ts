import {
  type DeserializeMdOptions,
  defaultRules,
  getDeserializerByKey,
  type MdRules,
} from "@platejs/markdown";
import { type Descendant, type TElement, type TText, TextApi } from "platejs";

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
          const leaf = text(...args) as TText;
          if (leaf.text === ZWSP) zwspTexts.add(leaf);
          return leaf;
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

export const markdownParagraphRules: MdRules = {
  p: {
    deserialize: deserializeParagraph,
    serialize: (node, options) =>
      paragraph.serialize!(
        node.children.every(isEmptyText)
          ? node
          : { ...node, children: node.children.filter((c) => !isEmptyText(c)) },
        options,
      ),
  },
};
