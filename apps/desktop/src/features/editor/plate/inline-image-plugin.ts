import {
  type Descendant,
  ElementApi,
  type SlateEditor,
  type TElement,
  TextApi,
  type Value,
} from "platejs";
import { createPlatePlugin } from "platejs/react";

import { INLINE_IMAGE_KEY } from "../model/markdown-inline-image";
import { InlineImageElement } from "../ui/inline-image-element";

function holdsInlineImage(element: TElement): boolean {
  return element.children.some(
    (child) =>
      ElementApi.isElement(child) &&
      (child.type === INLINE_IMAGE_KEY || holdsInlineImage(child)),
  );
}

/**
 * The value is loaded without normalization, so an image at the edge of its
 * line, alone in a heading or alone in a link has no text beside it, and the
 * caret cannot reach that side to type. Lines holding an inline image get
 * Slate's normal form: a text on each side of every inline element.
 */
function withTextsAroundInlines(
  editor: SlateEditor,
  node: Descendant,
): Descendant {
  if (!ElementApi.isElement(node) || !holdsInlineImage(node)) return node;
  const children: Descendant[] = [];
  for (const child of node.children) {
    const next = withTextsAroundInlines(editor, child);
    if (editor.api.isInline(next) && !TextApi.isText(children.at(-1))) {
      children.push({ text: "" });
    }
    children.push(next);
  }
  if (
    children.some((child) => editor.api.isInline(child)) &&
    !TextApi.isText(children.at(-1))
  ) {
    children.push({ text: "" });
  }
  return { ...node, children };
}

export const InlineImagePlugin = createPlatePlugin({
  key: INLINE_IMAGE_KEY,
  node: {
    isElement: true,
    isInline: true,
    isVoid: true,
    component: InlineImageElement,
  },
  transformInitialValue: ({ editor, value }) =>
    value.map((node) => withTextsAroundInlines(editor, node)) as Value,
});
