import type { DeserializeMdOptions, MdImage, MdRules } from "@platejs/markdown";
import { getPluginType, type TElement } from "platejs";

import {
  imageReferenceNode,
  type MarkdownReference,
  referenceOf,
  writableReference,
} from "./markdown-references";
import type { MdastNode } from "./markdown-source";

/**
 * Plate's image is a block, and its paragraph rule moves every image out of
 * the paragraph, which splits the line around it. An image that shares its
 * line with other content is read as an inline void element of its own
 * instead, and written back where it stands. An image alone in its paragraph
 * or table cell stays Plate's block. Which one an image is follows from the
 * Markdown on every read; the file holds `![alt](url "title")` either way.
 */
export const INLINE_IMAGE_KEY = "inline_img";

export interface InlineImageElement extends TElement {
  type: typeof INLINE_IMAGE_KEY;
  url: string;
  alt: string;
  title?: string;
  reference?: MarkdownReference;
  children: [{ text: "" }];
}

// Phrasing nodes whose content belongs to the line around them.
const TRANSPARENT_TYPES = new Set(["emphasis", "strong", "delete"]);

function isLineBreak(node: MdastNode): boolean {
  return (
    node.type === "break" ||
    (node.type === "mdxJsxTextElement" &&
      (node as MdastNode & { name?: string }).name === "br")
  );
}

function isBlank(node: MdastNode): boolean {
  return isLineBreak(node) || (node.type === "text" && !node.value?.trim());
}

/** The line content of a container, formatting unwrapped. */
function lineContent(nodes: MdastNode[]): MdastNode[] {
  return nodes.flatMap((node) =>
    TRANSPARENT_TYPES.has(node.type)
      ? lineContent(node.children ?? [])
      : [node],
  );
}

/**
 * Images of a paragraph or table cell are inline when the container holds
 * anything besides one image and whitespace: text, another inline element or
 * another image.
 */
function markInlineImages(container: MdastNode) {
  const content = lineContent(container.children ?? []).filter(
    (node) => !isBlank(node),
  );
  if (content.length < 2) return;
  for (const node of content) {
    if (node.type === "image") node.type = INLINE_IMAGE_KEY;
  }
}

const CONTAINER_TYPES = new Set(["paragraph", "tableCell"]);

function markContainers(node: MdastNode) {
  if (CONTAINER_TYPES.has(node.type)) markInlineImages(node);
  for (const child of node.children ?? []) markContainers(child);
}

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];

export const remarkInlineImages = function () {
  return markContainers;
} as unknown as RemarkPlugin;

export const markdownInlineImageRules: MdRules = {
  [INLINE_IMAGE_KEY]: {
    deserialize: (mdastNode: MdImage, _deco, options) => {
      const { alt, title, url } = mdastNode;
      const reference = referenceOf(mdastNode);
      return {
        type: options.editor
          ? getPluginType(options.editor, INLINE_IMAGE_KEY)
          : INLINE_IMAGE_KEY,
        url,
        alt: alt ?? "",
        ...(typeof title === "string" && { title }),
        ...(reference && { reference }),
        children: [{ text: "" }],
      };
    },
    serialize: (node: InlineImageElement, options) => {
      const { alt, title, url } = node;
      const reference = writableReference(node, options);
      if (reference) return imageReferenceNode(reference, alt);
      return {
        type: "image",
        url,
        alt,
        title: typeof title === "string" ? title : undefined,
      };
    },
  },
};
