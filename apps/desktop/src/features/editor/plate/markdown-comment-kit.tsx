import { createPlatePlugin } from "platejs/react";

import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
} from "../model/markdown-comments";
import {
  MarkdownCommentElement,
  MarkdownInlineCommentElement,
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
];
