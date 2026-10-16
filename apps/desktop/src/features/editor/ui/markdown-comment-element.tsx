import { PlateElement, type PlateElementProps } from "platejs/react";

import type { MarkdownCommentElement as TMarkdownCommentElement } from "../model/markdown-comments";

/** Block Markdown comment: its source text, kept out of editing. */
export function MarkdownCommentElement(
  props: PlateElementProps<TMarkdownCommentElement>,
) {
  return (
    <PlateElement {...props}>
      <div
        contentEditable={false}
        className="truncate font-mono text-xs text-muted-foreground select-none"
      >
        {props.element.raw}
      </div>
      {props.children}
    </PlateElement>
  );
}

/** Inline Markdown comment inside a line of text. */
export function MarkdownInlineCommentElement(
  props: PlateElementProps<TMarkdownCommentElement>,
) {
  return (
    <PlateElement {...props} as="span">
      <span
        contentEditable={false}
        className="font-mono text-xs text-muted-foreground select-none"
      >
        {props.element.raw}
      </span>
      {props.children}
    </PlateElement>
  );
}
