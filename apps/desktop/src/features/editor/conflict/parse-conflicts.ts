import type { Descendant, TElement } from "platejs";
import type { PlateEditor } from "platejs/react";
import {
  deserializeEditorMarkdownInsertion,
  deserializeEditorMarkdownSegment,
} from "../model/markdown-io";
import {
  type LinkDefinitions,
  linkDefinitionsOf,
} from "../model/markdown-references";
import { findConflictBlocks } from "./conflict-markers";

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

/**
 * Split raw markdown on the Git conflict blocks of markers of `markerSize` and
 * deserialize each non-conflict segment via the Plate Markdown plugin.
 * Conflict blocks become custom `conflict` elements with `ours` / `theirs`
 * stored as raw markdown strings. Text keeps its line endings. Reference links
 * of a segment resolve by the link definitions of all segments.
 */
export function deserializeWithConflicts(
  editor: PlateEditor,
  body: string,
  markerSize: number,
): Descendant[] {
  let cursor = 0;
  const parts: (string | ConflictElement)[] = [];

  for (const block of findConflictBlocks(body, markerSize)) {
    parts.push(body.slice(cursor, block.start), {
      type: "conflict",
      ours: block.ours,
      theirs: block.theirs,
      children: [{ text: "" }],
    });
    cursor = block.end;
  }
  parts.push(body.slice(cursor));

  const deserializeParts = (definitions?: LinkDefinitions) =>
    parts.flatMap((part) => {
      if (typeof part !== "string") return [part as unknown as Descendant];
      if (part.length === 0) return [];
      return deserializeEditorMarkdownSegment(editor, part, definitions);
    });

  let result = deserializeParts();
  if (parts.length > 1) {
    const definitions = linkDefinitionsOf(editor, result);
    if (definitions.size > 0) result = deserializeParts(definitions);
  }

  // Plate requires at least one block-level node
  if (result.length === 0) {
    result.push({ type: "p", children: [{ text: "" }] } as Descendant);
  }

  return result;
}

/**
 * Deserialize a conflict branch, or both joined for Edit, to replace its
 * conflict element. Reference links resolve by the branch's own link
 * definitions first, then by the document's.
 */
export function deserializeConflictBranch(
  editor: PlateEditor,
  markdown: string,
): Descendant[] {
  const nodes = deserializeEditorMarkdownInsertion(editor, markdown);
  const document = linkDefinitionsOf(editor, editor.children);
  if (document.size === 0) return nodes;
  const definitions = new Map(linkDefinitionsOf(editor, nodes));
  for (const [identifier, definition] of document) {
    if (!definitions.has(identifier)) definitions.set(identifier, definition);
  }
  return deserializeEditorMarkdownInsertion(editor, markdown, definitions);
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
