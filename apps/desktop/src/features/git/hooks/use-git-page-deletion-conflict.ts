import { useEffect, useState } from "react";
import {
  readGitConflictFile,
  readGitPathConflictKind,
  resolveGitDeletionConflict,
} from "../api/git-conflict-actions";
import {
  notifyGitPageChoiceOutcome,
  notifyGitResolveFailed,
} from "../effects/git-notifications";
import {
  conflictEditedSide,
  gitStatusPathInConflict,
  useGitStore,
  type GitConflictFile,
  type GitSyncOutcome,
} from "../model";

/** «Оставить с правками» or «Удалить». */
export type GitDeletionChoice = "keep" | "delete";

/**
 * A Page in a conflict of an edit against a deletion (modify/delete) and
 * the choice that resolves it as "Changes" do (DF-354 R3).
 */
export interface GitPageDeletionConflict {
  /** The side that deleted the Page; the other one edited it. */
  deletedBy: "ours" | "theirs";
  /**
   * Resolves the path by `choice`; the last resolved path finishes the merge
   * and publishes it. The outcome is named for the Page `page`, never
   * thrown; true when the path is resolved.
   */
  resolve: (choice: GitDeletionChoice, page: string) => Promise<boolean>;
}

/**
 * The modify/delete conflict of the Page `path` (relative to `spacePath`),
 * read each time Git starts to hold it unresolved: a new value for every
 * such conflict, null while the path is not in one or its kind is unknown.
 */
export function useGitPageDeletionConflict(
  spacePath: string | null,
  path: string | null,
): GitPageDeletionConflict | null {
  const inConflict = useGitStore(
    (state) =>
      spacePath !== null &&
      path !== null &&
      gitStatusPathInConflict(state.statuses[spacePath], path),
  );
  const key = `${spacePath}\0${path}`;
  const [read, setRead] = useState<{
    key: string;
    conflict: GitPageDeletionConflict | null;
  } | null>(null);
  // A conflict that ended is not shown again by the next one at the path.
  if (!inConflict && read !== null) setRead(null);

  useEffect(() => {
    if (!inConflict || spacePath === null || path === null) return;
    let active = true;
    readDeletionConflictFile(spacePath, path).then(
      (file) => {
        if (active)
          setRead({
            key,
            conflict: file ? deletionConflict(spacePath, path, file) : null,
          });
      },
      (error) => console.error("git conflict kind unavailable:", error),
    );
    return () => {
      active = false;
    };
  }, [inConflict, key, path, spacePath]);

  return inConflict && read?.key === key ? read.conflict : null;
}

async function readDeletionConflictFile(
  spacePath: string,
  path: string,
): Promise<GitConflictFile | null> {
  const kind = await readGitPathConflictKind(spacePath, path);
  if (kind !== "modify_delete") return null;
  return readGitConflictFile(spacePath, path);
}

function deletionConflict(
  spacePath: string,
  path: string,
  file: GitConflictFile,
): GitPageDeletionConflict {
  return {
    deletedBy: conflictEditedSide(file) === "ours" ? "theirs" : "ours",
    resolve: async (choice, page) => {
      try {
        const outcome = await resolveGitDeletionConflict(
          spacePath,
          path,
          file,
          choice,
        );
        notifyGitPageChoiceOutcome(outcome, page);
        return resolvedBy(outcome);
      } catch (error) {
        console.error("git conflict choice failed:", error);
        notifyGitResolveFailed(page);
        return false;
      }
    },
  };
}

// A stop of the publication after the merge is no refusal of the choice.
function resolvedBy(outcome: GitSyncOutcome): boolean {
  if (outcome.type === "Unresolved") return false;
  return !(outcome.type === "Failed" && !outcome.block && !outcome.stop);
}
