import type { Descendant, TElement } from "platejs";
import type { PlateEditor } from "platejs/react";
import {
  deserializeEditorMarkdownInsertion,
  deserializeEditorMarkdownSegment,
  fencedCodeRanges,
} from "../model/markdown-io";
import {
  type LinkDefinitions,
  linkDefinitionsOf,
} from "../model/markdown-references";
import type { AmbiguousConflict, ConflictText } from "./conflict-markers";
import { findConflictPlaces } from "./conflict-places";

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
  /**
   * The common version of the block both sides changed, `null` when it is
   * unavailable; `""` is an empty one.
   */
  base: string | null;
  children: [{ text: "" }];
}

/**
 * A conflict element of a block whose marker lines allow more than one split:
 * it shows the text of the block and offers only Edit.
 */
export interface AmbiguousConflictElement extends TElement {
  type: "conflict";
  ambiguous: AmbiguousConflict;
  children: [{ text: "" }];
}

export function isAmbiguousConflict(
  element: ConflictElement | AmbiguousConflictElement,
): element is AmbiguousConflictElement {
  return element.ambiguous !== undefined;
}

/**
 * Split raw markdown on the conflict places of the Git blocks of markers of
 * `markerSize` and deserialize each segment between them via the Plate
 * Markdown plugin. A place takes in the fenced code blocks its blocks cut
 * (DF-303 R1), so every segment and side reads whole Markdown blocks. Places
 * become custom `conflict` elements with `ours` / `theirs` stored as raw
 * markdown strings with the base of the place, from `bases[i]` for the block
 * `i` in document order, ambiguous places with their lines. Text keeps its
 * line endings. Reference links of a segment resolve by the link definitions
 * of all segments.
 */
export function deserializeWithConflicts(
  editor: PlateEditor,
  body: string,
  markerSize: number,
  bases: readonly (string | null)[] = [],
): Descendant[] {
  let cursor = 0;
  const parts: (string | ConflictElement | AmbiguousConflictElement)[] = [];

  const places = findConflictPlaces(body, markerSize, bases, (markdown) =>
    fencedCodeRanges(editor, markdown),
  );
  for (const place of places) {
    parts.push(
      body.slice(cursor, place.start),
      place.ambiguous
        ? {
            type: "conflict",
            ambiguous: place.ambiguous,
            children: [{ text: "" }],
          }
        : {
            type: "conflict",
            ours: place.ours,
            theirs: place.theirs,
            base: place.base,
            children: [{ text: "" }],
          },
    );
    cursor = place.end;
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
 * Deserialize the conflict branches `markdowns` to replace their conflict
 * element, each branch as it stands, one after another; an empty branch adds
 * nothing beside another one. Reference links resolve by the link
 * definitions of the branches first, then by the document's.
 */
export function deserializeConflictBranches(
  editor: PlateEditor,
  markdowns: string[],
): Descendant[] {
  const present = markdowns.filter((markdown) => markdown.trim().length > 0);
  return deserializeConflictRuns(
    editor,
    (present.length > 0 ? present : markdowns.slice(0, 1)).map(
      (markdown) => markdown.trim() + "\n",
    ),
  ).flat();
}

/**
 * Deserialize the Edit text of an ambiguous conflict block to replace its
 * conflict element. Marker lines become paragraphs of plain text; the runs of
 * text between them go through Markdown IO like a branch, and their reference
 * links resolve by the link definitions of all runs first, then by the
 * document's.
 */
export function deserializeAmbiguousConflictEdit(
  editor: PlateEditor,
  edit: ConflictText[],
): Descendant[] {
  const runs = edit
    .filter(({ marker, text }) => !marker && text.trim().length > 0)
    .map(({ text }) => text.trim() + "\n");
  const nodes = deserializeConflictRuns(editor, runs);
  let run = 0;
  return edit.flatMap(({ marker, text }) => {
    if (marker) return [{ type: "p", children: [{ text }] } as Descendant];
    return text.trim().length > 0 ? nodes[run++] : [];
  });
}

/**
 * Deserialize runs of conflict text. Reference links resolve by the link
 * definitions of the runs first, then by the document's.
 */
function deserializeConflictRuns(
  editor: PlateEditor,
  runs: string[],
): Descendant[][] {
  const nodes = runs.map((run) =>
    deserializeEditorMarkdownInsertion(editor, run),
  );
  const document = linkDefinitionsOf(editor, editor.children);
  // A single run already resolves by its own definitions.
  if (runs.length < 2 && document.size === 0) return nodes;
  const definitions: LinkDefinitions = new Map();
  for (const value of [...nodes, editor.children]) {
    for (const [identifier, definition] of linkDefinitionsOf(editor, value)) {
      if (!definitions.has(identifier)) definitions.set(identifier, definition);
    }
  }
  if (definitions.size === 0) return nodes;
  return runs.map((run) =>
    deserializeEditorMarkdownInsertion(editor, run, definitions),
  );
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
