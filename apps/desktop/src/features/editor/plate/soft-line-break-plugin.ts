import { createSlatePlugin, NodeApi, RangeApi, TextApi } from "platejs";

import {
  isSoftLineBreak,
  SOFT_LINE_BREAK,
} from "../model/markdown-line-breaks";

const NOT_LINE_BREAK_RE = /[^\n]/;

/**
 * A soft line break of the file stays a text of line endings only: text
 * typed next to it, Shift+Enter included, does not take its mark, and text
 * that reaches it another way is split off.
 */
export const SoftLineBreakPlugin = createSlatePlugin({
  key: "markdownSoftLineBreak",
}).overrideEditor(({ editor, tf: { insertText, normalizeNode } }) => ({
  transforms: {
    insertText(text, options) {
      if (!options?.at && editor.selection) {
        if (editor.marks && SOFT_LINE_BREAK in editor.marks) {
          const { [SOFT_LINE_BREAK]: _soft, ...marks } = editor.marks;
          editor.marks = marks;
        } else if (!editor.marks) {
          const leaf = NodeApi.get(
            editor,
            RangeApi.start(editor.selection).path,
          );
          if (TextApi.isText(leaf) && isSoftLineBreak(leaf)) {
            const { text: _text, [SOFT_LINE_BREAK]: _soft, ...marks } = leaf;
            editor.marks = marks;
          }
        }
      }
      insertText(text, options);
    },
    normalizeNode(entry, options) {
      const [node, path] = entry;
      if (
        TextApi.isText(node) &&
        isSoftLineBreak(node) &&
        NOT_LINE_BREAK_RE.test(node.text)
      ) {
        const breaks = /\n+/.exec(node.text);
        if (!breaks) {
          editor.tf.unsetNodes(SOFT_LINE_BREAK, { at: path });
          return;
        }
        const { text: _text, ...properties } = node;
        editor.tf.apply({
          type: "split_node",
          path,
          position: breaks.index || breaks[0].length,
          properties,
        });
        return;
      }
      normalizeNode(entry, options);
    },
  },
}));
