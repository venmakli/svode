import { type Descendant, ElementApi, type SlateEditor } from "platejs";

import { isEmptyParagraph } from "./empty-document";

/**
 * The paragraph `TrailingBlockPlugin` adds after a last block that is not a
 * paragraph is marked as the editor's own. While it is the last block and
 * empty it is not part of the document, so the Markdown never carries it.
 */
export const TRAILING_BLOCK_MARK = "svodeTrailingBlock";

function isServiceTrailingBlock(
  editor: SlateEditor,
  node: Descendant | undefined,
): boolean {
  return (
    ElementApi.isElement(node) &&
    node[TRAILING_BLOCK_MARK] === true &&
    isEmptyParagraph(editor, node)
  );
}

export function withoutServiceTrailingBlock(
  editor: SlateEditor,
  nodes: Descendant[],
): Descendant[] {
  return isServiceTrailingBlock(editor, nodes.at(-1))
    ? nodes.slice(0, -1)
    : nodes;
}
