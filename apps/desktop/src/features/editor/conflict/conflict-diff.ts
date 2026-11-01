import { computeDiff } from "@platejs/diff";
import type { Descendant, Value } from "platejs";
import type { PlateEditor } from "platejs/react";

import { deserializeConflictBranches } from "./parse-conflicts";

/** The sides of a conflict block as shown, with their differences marked. */
export interface ConflictSidesDiff {
  ours: Value;
  theirs: Value;
  /** Whether both sides are marked against the base; else theirs is marked against ours. */
  againstBase: boolean;
}

/**
 * The sides of a conflict block marked with what each changed in the base,
 * or, without a base, theirs marked against ours. A side that removed the
 * text of the block shows the base deleted. Every value is deserialized
 * apart, since `computeDiff` and every editor need values of their own.
 */
export function diffConflictSides(
  editor: PlateEditor,
  sides: { ours: string; theirs: string; base: string | null },
): ConflictSidesDiff {
  const read = (markdown: string): Descendant[] =>
    markdown.trim().length > 0
      ? deserializeConflictBranches(editor, [markdown])
      : [];
  const diff = (previous: string, current: string) =>
    computeDiff(read(previous), read(current), {
      isInline: editor.api.isInline,
      lineBreakChar: "¶",
    }) as Value;

  if (sides.base === null) {
    return {
      ours: read(sides.ours) as Value,
      theirs: diff(sides.ours, sides.theirs),
      againstBase: false,
    };
  }
  return {
    ours: diff(sides.base, sides.ours),
    theirs: diff(sides.base, sides.theirs),
    againstBase: true,
  };
}
