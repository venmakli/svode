import type { Descendant } from "platejs";
import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";

import {
  annotateMarkdownComment,
  escapeUnclosedCommentOpeners,
} from "./markdown-comments";
import {
  applyTextEdits,
  composeMappedText,
  markdownSourcePlugin,
  type TextEdit,
} from "./markdown-source";

function emptyParagraph(): Descendant {
  return { type: "p", children: [{ text: "" }] } as Descendant;
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
const BARE_BREAK_RE = /<br\s*>/gi;

function bareBreakEdits(text: string, offset: number): TextEdit[] {
  return [...text.matchAll(BARE_BREAK_RE)].map((match) => ({
    start: offset + match.index,
    end: offset + match.index + match[0].length,
    text: "<br />",
  }));
}

function bareBreakEditsOutsideInlineCode(
  line: string,
  offset: number,
): TextEdit[] {
  const edits: TextEdit[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);
    if (codeStart === -1) {
      edits.push(...bareBreakEdits(line.slice(cursor), offset + cursor));
      break;
    }

    edits.push(
      ...bareBreakEdits(line.slice(cursor, codeStart), offset + cursor),
    );

    let tickCount = 1;
    while (line[codeStart + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const codeEnd = line.indexOf(fence, codeStart + tickCount);
    if (codeEnd === -1) break;

    cursor = codeEnd + tickCount;
  }

  return edits;
}

function bareBreakNormalizationEdits(markdown: string): TextEdit[] {
  const lines = markdown.split(/(\r\n|\n|\r)/);
  const edits: TextEdit[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  let offset = 0;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const lineOffset = offset;
    offset += line.length + (lines[index + 1]?.length ?? 0);
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

    edits.push(...bareBreakEditsOutsideInlineCode(line, lineOffset));
  }

  return edits;
}

export function normalizeMarkdownForPlate(markdown: string): string {
  return applyTextEdits(markdown, bareBreakNormalizationEdits(markdown)).text;
}

export function deserializeEditorMarkdownSegment(
  editor: PlateEditor,
  markdown: string,
): Descendant[] {
  const escaped = escapeUnclosedCommentOpeners(editor, markdown);
  const plateInput = composeMappedText(
    escaped,
    applyTextEdits(escaped.text, bareBreakNormalizationEdits(escaped.text)),
  );
  const markdownApi = editor.getApi(MarkdownPlugin).markdown;
  const nodes = markdownApi.deserialize(plateInput.text, {
    remarkPlugins: [
      ...(editor.getOptions(MarkdownPlugin).remarkPlugins ?? []),
      markdownSourcePlugin(markdown, plateInput, [annotateMarkdownComment]),
    ],
  });

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
