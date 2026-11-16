import { useState } from "react";
import { toast } from "sonner";

import {
  useGitPageDeletionConflict,
  type GitDeletionChoice,
  type GitPageDeletionConflict,
} from "@/features/git/editor";
import { trackOwnContentDeletion } from "@/features/page/page-api";
import * as m from "@/paraglide/messages.js";

/**
 * The choice for an open Page in a conflict of an edit against a deletion
 * (DF-354 R3): asked each time the Page opens or comes into one, until the
 * path is resolved. «Позже» leaves it unresolved; the other choices write
 * the draft first and resolve the path as "Changes" do. After «Удалить» the
 * Page closes as one deleted here does.
 */
export function usePageDeletionConflictChoice({
  spacePath,
  path,
  title,
  enabled,
  settlePendingSource,
}: {
  spacePath: string | null;
  path: string | null;
  /** The Page as the question and its outcome name it. */
  title: string;
  /** False where nothing may be written, such as a read-only Page. */
  enabled: boolean;
  /** Writes the draft; false when it stays unsaved. */
  settlePendingSource: () => Promise<boolean>;
}) {
  const conflict = useGitPageDeletionConflict(
    enabled ? spacePath : null,
    enabled ? path : null,
  );
  const [dismissed, setDismissed] = useState<GitPageDeletionConflict | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const open = conflict !== null && conflict !== dismissed;
  // Keeps the copy of the closing question during its exit animation.
  const [shown, setShown] = useState(conflict);
  if (open && conflict !== shown) setShown(conflict);

  const later = () => {
    if (!pending && conflict) setDismissed(conflict);
  };

  const choose = async (choice: GitDeletionChoice) => {
    if (!conflict || conflict === dismissed || pending) return;
    if (!spacePath || !path) return;
    setPending(true);
    try {
      if (!(await savedBeforeChoice(settlePendingSource))) {
        toast.error(m.page_surface_save_error());
        return;
      }
      if (choice === "keep") {
        await conflict.resolve("keep", title);
        return;
      }
      // Known as this Desktop's deletion, the Page closes without news.
      await trackOwnContentDeletion({ spacePath, path }, async () => {
        if (!(await conflict.resolve("delete", title)))
          throw new Error("the deletion did not resolve the Page");
      }).catch(() => {});
    } finally {
      setPending(false);
      setDismissed(conflict);
    }
  };

  return {
    open,
    /** The side that deleted the Page in the question shown. */
    deletedBy: shown?.deletedBy ?? null,
    pending,
    later,
    choose,
  };
}

async function savedBeforeChoice(
  settlePendingSource: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await settlePendingSource();
  } catch (error) {
    console.error(
      "Failed to write the Page before the conflict choice:",
      error,
    );
    return false;
  }
}
