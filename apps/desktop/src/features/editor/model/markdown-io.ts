import type { Descendant } from "platejs";
import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";

import {
  annotateMarkdownComment,
  escapeUnclosedCommentOpeners,
} from "./markdown-comments";
import {
  escapedOpenerEdits,
  restoreMarkdownLiteral,
} from "./markdown-literals";
import {
  createReferenceResolution,
  type LinkDefinitions,
  type ReferenceResolution,
} from "./markdown-references";
import {
  applyTextEdits,
  composeMappedText,
  type MappedText,
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

const LEADING_BLANK_LINES_RE = /^(?:[ \t]*\r?\n)*/;

function leadingBlankLines(text: string): string {
  return LEADING_BLANK_LINES_RE.exec(text)?.[0] ?? "";
}

/**
 * The body a save writes for the serialized editor value. Parsing drops the
 * blank lines before the first block, so the ones of the source body the
 * editor was loaded from or last written as lead the text again, byte for byte.
 */
export function bodyWithSourceLeadingBlankLines(
  sourceBody: string,
  markdown: string,
): string {
  return (
    leadingBlankLines(sourceBody) +
    markdown.slice(leadingBlankLines(markdown).length)
  );
}

const CRLF_RE = /\r\n/g;

// CRLF ends a line like LF. Plate splits text and code values at LF only, so
// the CR would stay in the editor value and be written back. The boundary
// reads the text with LF endings as its source, which comments and literals
// are restored from as well.
function withLfLineEndings(markdown: string): string {
  return markdown.replace(CRLF_RE, "\n");
}

export function normalizeMarkdownForPlate(markdown: string): string {
  return applyTextEdits(markdown, bareBreakNormalizationEdits(markdown)).text;
}

function plateInputFor(
  editor: PlateEditor,
  markdown: string,
  literalEdits: TextEdit[],
): MappedText {
  const literal = applyTextEdits(markdown, literalEdits);
  const escaped = escapeUnclosedCommentOpeners(editor, literal.text);
  return composeMappedText(
    literal,
    escaped,
    applyTextEdits(escaped.text, bareBreakNormalizationEdits(escaped.text)),
  );
}

function deserializeBoundaryMarkdown(
  editor: PlateEditor,
  markdown: string,
  references: ReferenceResolution,
): Descendant[] {
  const markdownApi = editor.getApi(MarkdownPlugin).markdown;
  const remarkPlugins = editor.getOptions(MarkdownPlugin).remarkPlugins ?? [];
  const deserialize = (plateInput: MappedText, onError?: () => void) =>
    markdownApi.deserialize(plateInput.text, {
      onError,
      remarkPlugins: [
        // References are links and images before any other plugin runs.
        references.plugin,
        ...remarkPlugins,
        markdownSourcePlugin(markdown, plateInput, [
          annotateMarkdownComment,
          restoreMarkdownLiteral,
        ]),
      ],
    });

  const literalEdits = escapedOpenerEdits(markdown);
  let fellBack = false;
  let nodes = deserialize(plateInputFor(editor, markdown, literalEdits), () => {
    fellBack = true;
  });
  // Plate's fallback parse runs no annotators, so it would keep the
  // replacements of `escapedOpenerEdits` inside code.
  if (fellBack && literalEdits.length > 0) {
    nodes = deserialize(plateInputFor(editor, markdown, []));
  }

  return Array.isArray(nodes) ? (nodes as Descendant[]) : [];
}

/**
 * Reference links and images of the segment resolve by `definitions`, the
 * link definitions of the whole document, or by the segment's own when there
 * are none.
 */
export function deserializeEditorMarkdownSegment(
  editor: PlateEditor,
  segment: string,
  definitions?: LinkDefinitions,
): Descendant[] {
  const markdown = withLfLineEndings(segment);
  if (definitions && definitions.size > 0) {
    const references = createReferenceResolution(definitions);
    const nodes = deserializeBoundaryMarkdown(
      editor,
      markdown + references.suffix,
      references,
    );
    if (references.isComplete()) return nodes;
    // The segment ends inside a block that took in the appended definitions;
    // its references resolve by its own.
  }
  return deserializeBoundaryMarkdown(
    editor,
    markdown,
    createReferenceResolution(),
  );
}

export function deserializeEditorMarkdownInsertion(
  editor: PlateEditor,
  markdown: string,
  definitions?: LinkDefinitions,
): Descendant[] {
  const nodes = deserializeEditorMarkdownSegment(editor, markdown, definitions);
  if (nodes.length > 0) return nodes;

  const fallbackText = withLfLineEndings(markdown).trimEnd();
  return fallbackText
    ? ([{ type: "p", children: [{ text: fallbackText }] }] as Descendant[])
    : [emptyParagraph()];
}
