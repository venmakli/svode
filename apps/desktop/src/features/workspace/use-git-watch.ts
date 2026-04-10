import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useGitStore } from "@/stores/git";

/**
 * Per-workspace `workspace:dirty` listener + initial `git_status` fetch.
 *
 * Stage-3 triggers for status refresh:
 *  1. Git commands (handled by callers — they pass returned WorkspaceGitStatus
 *     to `applyStatus` directly).
 *  2. `workspace:dirty` event from file watcher (any file change) → debounced
 *     `git_status` call — implemented here.
 *  3. Window `focus` event + `syncOnOpen` — implemented ONCE at the app level
 *     (see `useAppGitFocus`), not per workspace row.
 */
export function useGitWatch(workspacePath: string | null) {
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    let unlistenDirty: (() => void) | null = null;
    let cancelled = false;

    // Initial status fetch — cheap, no network.
    useGitStore.getState().refreshStatus(workspacePath);

    listen<{ workspace: string }>("workspace:dirty", (event) => {
      if (cancelled) return;
      if (event.payload.workspace !== workspacePath) return;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        useGitStore.getState().refreshStatus(workspacePath);
      }, 500);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenDirty = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (unlistenDirty) unlistenDirty();
    };
  }, [workspacePath]);
}
