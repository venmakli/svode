import type { Descendant } from "platejs";
import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";

function emptyParagraph(): Descendant {
  return { type: "p", children: [{ text: "" }] } as Descendant;
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

function normalizeBareBreaksOutsideInlineCode(line: string): string {
  let normalized = "";
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);
    if (codeStart === -1) {
      normalized += line.slice(cursor).replace(/<br\s*>/gi, "<br />");
      break;
    }

    normalized += line.slice(cursor, codeStart).replace(/<br\s*>/gi, "<br />");

    let tickCount = 1;
    while (line[codeStart + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const codeEnd = line.indexOf(fence, codeStart + tickCount);
    if (codeEnd === -1) {
      normalized += line.slice(codeStart);
      break;
    }

    normalized += line.slice(codeStart, codeEnd + tickCount);
    cursor = codeEnd + tickCount;
  }

  return normalized;
}

export function normalizeMarkdownForPlate(markdown: string): string {
  const lines = markdown.split(/(\r\n|\n|\r)/);
  let fence: { char: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const match = line.match(FENCE_RE);

    if (fence) {
      if (
        match &&
        match[2]?.[0] === fence.char &&
        match[2].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    if (match) {
      fence = {
        char: match[2][0] as "`" | "~",
        length: match[2].length,
      };
      continue;
    }

    lines[index] = normalizeBareBreaksOutsideInlineCode(line);
  }

  return lines.join("");
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
