import {
  type Descendant,
  ElementApi,
  getPluginType,
  KEYS,
  type SlateEditor,
  TextApi,
} from "platejs";

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
    !!node &&
    ElementApi.isElement(node) &&
    node[TRAILING_BLOCK_MARK] === true &&
    node.type === getPluginType(editor, KEYS.p) &&
    !("listStyleType" in node) &&
    node.children.every((child) => TextApi.isText(child) && child.text === "")
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
