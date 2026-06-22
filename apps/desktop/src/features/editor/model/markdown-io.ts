import type { Descendant } from "platejs";
import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";

function emptyParagraph(): Descendant {
  return { type: "p", children: [{ text: "" }] } as Descendant;
}

export function normalizeMarkdownForPlate(markdown: string): string {
  return markdown.replace(/<br\s*>/gi, "<br />");
}

export function deserializeEditorMarkdownSegment(
  editor: PlateEditor,
  markdown: string,
): Descendant[] {
  const nodes = editor
    .getApi(MarkdownPlugin)
    .markdown.deserialize(normalizeMarkdownForPlate(markdown));

  return Array.isArray(nodes) ? (nodes as Descendant[]) : [];
}

export function deserializeEditorMarkdownInsertion(
  editor: PlateEditor,
  markdown: string,
): Descendant[] {
  const nodes = deserializeEditorMarkdownSegment(editor, markdown);
  if (nodes.length > 0) return nodes;

  const fallbackText = markdown.trimEnd();
  return fallbackText
    ? ([{ type: "p", children: [{ text: fallbackText }] }] as Descendant[])
    : [emptyParagraph()];
}
