import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { gitSyncErrorMessage } from "../api/git-sync-error";
import { abortGitSyncMerge } from "../api/git-sync-stop-actions";
import * as m from "@/paraglide/messages.js";

export interface GitSyncAbort {
  aborting: boolean;
  /** Why the last cancellation was refused, until the next attempt. */
  error: string | null;
  abort: () => Promise<void>;
}

/**
 * Cancel the sync of the repository at `spacePath` stopped by a merge
 * conflict; a refusal stays only while that stop does.
 */
export function useGitSyncAbort(
  spacePath: string,
  stopped: boolean,
): GitSyncAbort {
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
    if (!stopped) setError(null);
  }, [stopped]);

  const abort = useCallback(async () => {
    if (!spacePath) return;
    const identity = active.current;
    setAborting(true);
    setError(null);
    try {
      await abortGitSyncMerge(spacePath);
      if (active.current !== identity) return;
      toast.success(m.git_sync_abort_success());
    } catch (err) {
      console.error("git_merge_abort failed:", err);
      if (active.current === identity) setError(gitSyncErrorMessage(err));
    } finally {
      if (active.current === identity) setAborting(false);
    }
  }, [spacePath]);

  return { aborting, error, abort };
}
