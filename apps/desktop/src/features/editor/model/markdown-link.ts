import {
  convertNodesSerialize,
  defaultRules,
  type MdLink,
  type MdLinkReference,
  type MdRules,
} from "@platejs/markdown";
import type { TLinkElement } from "platejs";

import {
  type MarkdownReference,
  referenceOf,
  writableReference,
} from "./markdown-references";

/**
 * Plate's link element has no title: its `a` rule drops the title of
 * `[text](url "title")` on read. The link element keeps it as `title`, which
 * moves, copies and is undone with the link, and is written back on save.
 * Links made in the editor have none. A link read from a reference link also
 * keeps that reference (see `markdown-references`).
 */
export type TitledLinkElement = TLinkElement & {
  title?: string;
  reference?: MarkdownReference;
};

const link = defaultRules.a!;

export const markdownLinkRules: MdRules = {
  a: {
    deserialize: (mdastNode, deco, options) => {
      const element = link.deserialize!(mdastNode, deco, options);
      const reference = referenceOf(mdastNode);
      return {
        ...element,
        ...(typeof mdastNode.title === "string" && { title: mdastNode.title }),
        ...(reference && { reference }),
      };
    },
    serialize: (node, options) => {
      const reference = writableReference(node as TitledLinkElement, options);
      if (reference) {
        const linkReference: MdLinkReference = {
          ...reference,
          children: convertNodesSerialize(
            node.children,
            options,
          ) as MdLinkReference["children"],
          type: "linkReference",
        };
        // Plate types the result of rule `a` as a link.
        return linkReference as unknown as MdLink;
      }
      const { title } = node as TitledLinkElement;
      if (typeof title !== "string") return link.serialize!(node, options);
      // Plate writes a link whose text is its URL as a bare autolink, which
      // has no title.
      return {
        children: convertNodesSerialize(
          node.children,
          options,
        ) as MdLink["children"],
        title,
        type: "link",
        url: node.url,
      };
    },
  },
};
