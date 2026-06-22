import { useEffect, useRef } from "react";
import { refreshGitStatus } from "../api/git-status-actions";
import {
  listenGitWatchCommitted,
  listenGitWatchDirty,
} from "../api/git-watch-actions";

/**
 * Per-space dirty listener + initial git status refresh.
 *
 * Stage-3 triggers for status refresh:
 *  1. Git commands (handled by callers — they pass returned GitStatus
 *     to `applyStatus` directly).
 *  2. Dirty event from file watcher (any file change) → debounced
 *     git status refresh — implemented here.
 *  3. Window `focus` event + `syncOnOpen` — implemented ONCE at the app level
 *     (see `useAppGitFocus`), not per space row.
 */
export function useGitWatch(spacePath: string | null) {
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!spacePath) return;
    let unlistenDirty: (() => void) | null = null;
    let unlistenCommitted: (() => void) | null = null;
    let cancelled = false;

    // Initial status refresh — cheap, no network.
    void refreshGitStatus(spacePath);

    listenGitWatchDirty((dirtySpacePath) => {
      if (cancelled) return;
      if (dirtySpacePath !== spacePath) return;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        void refreshGitStatus(spacePath);
      }, 500);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenDirty = unlisten;
      }
    });

    // Autocommit lands → clear any grey dot shown while the debounce was
    // pending. Refresh immediately, no debounce.
    listenGitWatchCommitted((committedSpacePath) => {
      if (cancelled) return;
      if (committedSpacePath !== spacePath) return;
      void refreshGitStatus(spacePath);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenCommitted = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (unlistenDirty) unlistenDirty();
      if (unlistenCommitted) unlistenCommitted();
    };
  }, [spacePath]);
}
