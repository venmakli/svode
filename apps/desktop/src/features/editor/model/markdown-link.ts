import {
  convertNodesSerialize,
  defaultRules,
  type MdLink,
  type MdRules,
} from "@platejs/markdown";
import type { TLinkElement } from "platejs";

/**
 * Plate's link element has no title: its `a` rule drops the title of
 * `[text](url "title")` on read. The link element keeps it as `title`, which
 * moves, copies and is undone with the link, and is written back on save.
 * Links made in the editor have none.
 */
export type TitledLinkElement = TLinkElement & { title?: string };

const link = defaultRules.a!;

export const markdownLinkRules: MdRules = {
  a: {
    deserialize: (mdastNode, deco, options) => {
      const element = link.deserialize!(mdastNode, deco, options);
      return typeof mdastNode.title === "string"
        ? { ...element, title: mdastNode.title }
        : element;
    },
    serialize: (node, options) => {
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
