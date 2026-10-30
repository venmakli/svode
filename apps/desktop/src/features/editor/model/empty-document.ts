import {
  type Descendant,
  ElementApi,
  getPluginType,
  KEYS,
  type SlateEditor,
  TextApi,
} from "platejs";

/** A paragraph with no text and no inline elements, not a list item. */
export function isEmptyParagraph(
  editor: SlateEditor,
  node: Descendant | undefined,
): boolean {
  return (
    !!node &&
    ElementApi.isElement(node) &&
    node.type === getPluginType(editor, KEYS.p) &&
    !("listStyleType" in node) &&
    node.children.every((child) => TextApi.isText(child) && child.text === "")
  );
}

/**
 * Plate keeps at least one block, so a document whose text is all deleted is
 * a single empty paragraph. `@platejs/markdown` writes an empty paragraph as
 * U+200B to keep it; this one is no content and its Markdown is empty.
 */
export function isEmptyDocument(
  editor: SlateEditor,
  nodes: Descendant[],
): boolean {
  return nodes.length === 1 && isEmptyParagraph(editor, nodes[0]);
}
