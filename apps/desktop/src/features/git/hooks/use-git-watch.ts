import { useEffect, useRef } from "react";
import { listen } from "@/platform/native/events";
import { useGitStore } from "@/stores/git";

/**
 * Per-space `space:dirty` listener + initial `git_status` fetch.
 *
 * Stage-3 triggers for status refresh:
 *  1. Git commands (handled by callers — they pass returned GitStatus
 *     to `applyStatus` directly).
 *  2. `space:dirty` event from file watcher (any file change) → debounced
 *     `git_status` call — implemented here.
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

    // Initial status fetch — cheap, no network.
    useGitStore.getState().refreshStatus(spacePath);

    listen<{ space: string }>("space:dirty", (event) => {
      if (cancelled) return;
      if (event.payload.space !== spacePath) return;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        useGitStore.getState().refreshStatus(spacePath);
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
    listen<{ spacePath: string; repoPath: string }>(
      "git:committed",
      (event) => {
        if (cancelled) return;
        if (event.payload.spacePath !== spacePath) return;
        useGitStore.getState().refreshStatus(spacePath);
      },
    ).then((unlisten) => {
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
