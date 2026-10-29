import { createPlatePlugin } from "platejs/react";

import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
  MARKDOWN_INLINE_LINK_DEFINITION_KEY,
  MARKDOWN_LINK_DEFINITION_KEY,
} from "../model/markdown-comments";
import {
  MarkdownCommentElement,
  MarkdownInlineCommentElement,
  MarkdownInlineLinkDefinitionElement,
  MarkdownLinkDefinitionElement,
} from "../ui/markdown-comment-element";

export const MarkdownCommentKit = [
  createPlatePlugin({
    key: MARKDOWN_COMMENT_KEY,
    node: {
      isElement: true,
      isVoid: true,
      component: MarkdownCommentElement,
    },
  }),
  createPlatePlugin({
    key: MARKDOWN_INLINE_COMMENT_KEY,
    node: {
      isElement: true,
      isInline: true,
      isVoid: true,
      component: MarkdownInlineCommentElement,
    },
  }),
  createPlatePlugin({
    key: MARKDOWN_LINK_DEFINITION_KEY,
    node: {
      isElement: true,
      isVoid: true,
      component: MarkdownLinkDefinitionElement,
    },
  }),
  createPlatePlugin({
    key: MARKDOWN_INLINE_LINK_DEFINITION_KEY,
    node: {
      isElement: true,
      isInline: true,
      isVoid: true,
      component: MarkdownInlineLinkDefinitionElement,
    },
  }),
];
