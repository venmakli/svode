import type { GitSideChange } from "@/features/git";
import { formatMediaBytes } from "@/features/media";
import * as m from "@/paraglide/messages.js";

/**
 * What each side did with a conflicted file without markers, as one line:
 * «Файл изменён у вас (12 KB), удалён у коллеги.»
 */
export function conflictSidesText(changes: {
  ours: GitSideChange;
  theirs: GitSideChange;
}): string {
  return m.changes_conflict_sides({
    ours: sideText(changes.ours, "ours"),
    theirs: sideText(changes.theirs, "theirs"),
  });
}

function sideText(side: GitSideChange, of: "ours" | "theirs"): string {
  const name = side.path ?? "";
  const change =
    of === "ours"
      ? {
          modified: m.changes_conflict_ours_modified,
          added: m.changes_conflict_ours_added,
          deleted: m.changes_conflict_ours_deleted,
          renamed: () => m.changes_conflict_ours_renamed({ name }),
        }[side.change]()
      : {
          modified: m.changes_conflict_theirs_modified,
          added: m.changes_conflict_theirs_added,
          deleted: m.changes_conflict_theirs_deleted,
          renamed: () => m.changes_conflict_theirs_renamed({ name }),
        }[side.change]();
  return side.size === null
    ? change
    : m.changes_conflict_side_size({
        change,
        size: formatMediaBytes(side.size),
      });
}
