import type { Descendant, TElement } from "platejs";
import type { PlateEditor } from "platejs/react";
import { deserializeEditorMarkdownSegment } from "../model/markdown-io";
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
 * stored as raw markdown strings. Text keeps its line endings.
 */
export function deserializeWithConflicts(
  editor: PlateEditor,
  body: string,
  markerSize: number,
): Descendant[] {
  let cursor = 0;
  const result: Descendant[] = [];

  const deserializeSegment = (segment: string) => {
    if (segment.length === 0) return;
    result.push(...deserializeEditorMarkdownSegment(editor, segment));
  };

  for (const block of findConflictBlocks(body, markerSize)) {
    deserializeSegment(body.slice(cursor, block.start));
    const conflict: ConflictElement = {
      type: "conflict",
      ours: block.ours,
      theirs: block.theirs,
      children: [{ text: "" }],
    };
    result.push(conflict as unknown as Descendant);
    cursor = block.end;
  }

  deserializeSegment(body.slice(cursor));

  // Plate requires at least one block-level node
  if (result.length === 0) {
    result.push({ type: "p", children: [{ text: "" }] } as Descendant);
  }

  return result;
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
