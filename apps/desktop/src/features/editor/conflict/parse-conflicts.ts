import type { Descendant, TElement } from "platejs";
import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";

/**
 * A conflict element in the Plate tree.
 * `isVoid: true` — Plate renders it as-is, users can't type inside.
 *
 * Index signature comes from `TElement` — required so we satisfy Plate's
 * `UnknownObject` constraint.
 */
export interface ConflictElement extends TElement {
  type: "conflict";
  ours: string;
  theirs: string;
  children: [{ text: "" }];
}

// Matches a full conflict region. The `\n?` before `=======`/`>>>>>>>`
// allows empty "ours" / "theirs" sections (one side deleted the whole block),
// which git still writes as `<<<<<<<\n=======\n...` or `...\n=======\n>>>>>>>`.
const CONFLICT_RE =
  /<{7} [^\n]*\n([\s\S]*?)\n?={7}\n([\s\S]*?)\n?>{7} [^\n]*(\n|$)/g;

/**
 * Split raw markdown on git conflict markers and deserialize each non-conflict
 * segment via the Plate Markdown plugin. Conflict segments become custom
 * `conflict` elements with `ours` / `theirs` stored as raw markdown strings.
 */
export function deserializeWithConflicts(
  editor: PlateEditor,
  body: string,
): Descendant[] {
  CONFLICT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let cursor = 0;
  const result: Descendant[] = [];

  const deserializeSegment = (segment: string) => {
    if (segment.length === 0) return;
    const nodes = editor
      .getApi(MarkdownPlugin)
      .markdown.deserialize(normalizeMarkdownForPlate(segment));
    if (Array.isArray(nodes)) {
      result.push(...(nodes as Descendant[]));
    }
  };

  while ((match = CONFLICT_RE.exec(body)) !== null) {
    const before = body.slice(cursor, match.index);
    deserializeSegment(before);
    const conflict: ConflictElement = {
      type: "conflict",
      ours: match[1],
      theirs: match[2],
      children: [{ text: "" }],
    };
    result.push(conflict as unknown as Descendant);
    cursor = match.index + match[0].length;
  }

  deserializeSegment(body.slice(cursor));

  // Plate requires at least one block-level node
  if (result.length === 0) {
    result.push({ type: "p", children: [{ text: "" }] } as Descendant);
  }

  return result;
}

export function normalizeMarkdownForPlate(markdown: string): string {
  return markdown.replace(/<br\s*>/gi, "<br />");
}

/** Does the given Plate value contain any unresolved conflict elements? */
export function hasUnresolvedConflicts(value: Descendant[]): boolean {
  for (const node of value) {
    if (
      typeof node === "object" &&
      node !== null &&
      (node as { type?: string }).type === "conflict"
    ) {
      return true;
    }
    const children = (node as { children?: Descendant[] }).children;
    if (Array.isArray(children) && hasUnresolvedConflicts(children)) {
      return true;
    }
  }
  return false;
}
