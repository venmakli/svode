import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { gitSyncErrorMessage } from "../api/git-sync-error";
import {
  abortGitOperationStop,
  abortGitSyncMerge,
} from "../api/git-sync-stop-actions";
import type { GitSyncStop } from "../model";
import * as m from "@/paraglide/messages.js";

export interface GitSyncAbort {
  aborting: boolean;
  /** Why the last cancellation was refused, until the next attempt. */
  error: string | null;
  abort: () => Promise<void>;
}

/** The stops a cancellation ends: a merge, or an operation Svode does not continue. */
type AbortableKind = "conflict" | "operation";

function abortable(stop: GitSyncStop | null | undefined): AbortableKind | null {
  return stop?.kind === "conflict" || stop?.kind === "operation"
    ? stop.kind
    : null;
}

/**
 * Cancel what stops the sync of the repository at `spacePath`: the merge of
 * a conflict («Отменить синхронизацию») or a rebase, cherry-pick, revert or
 * sequencer («Отменить <операцию>», Stage 11 1.F). A refusal stays only
 * while that stop does.
 */
export function useGitSyncAbort(
  spacePath: string,
  stop: GitSyncStop | null | undefined,
): GitSyncAbort {
  const kind = abortable(stop);
  const expectedHead =
    (stop?.kind === "operation" && stop.sequence?.head) || null;
  const active = useRef<object | null>(null);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = {};
    setAborting(false);
    setError(null);
    return () => {
      active.current = null;
    };
  }, [spacePath]);
  useEffect(() => {
    setError(null);
  }, [kind]);

  const abort = useCallback(async () => {
    if (!spacePath || !kind) return;
    const identity = active.current;
    setAborting(true);
    setError(null);
    try {
      if (kind === "operation")
        await abortGitOperationStop(spacePath, expectedHead);
      else await abortGitSyncMerge(spacePath);
      if (active.current !== identity) return;
      toast.success(
        kind === "operation"
          ? m.git_operation_abort_success()
          : m.git_sync_abort_success(),
      );
    } catch (err) {
      console.error(
        kind === "operation"
          ? "git_operation_abort failed:"
          : "git_merge_abort failed:",
        err,
      );
      if (active.current === identity) setError(gitSyncErrorMessage(err));
    } finally {
      if (active.current === identity) setAborting(false);
    }
  }, [expectedHead, kind, spacePath]);

  return { aborting, error, abort };
}
