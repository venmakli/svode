import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "@/stores/git";
import { useWorkspaceStore, selectActiveWorkspacePath } from "@/stores/workspace";
import type { WorkspaceGitStatus } from "@/types/git";
import { syncOnOpen } from "./git-actions";

/**
 * App-level git hooks that run once for the currently-active workspace:
 *  - `syncOnOpen` on workspace switch (silent pull+push if remote configured)
 *  - window `focus` → `git_status` + auto-push if `ahead > 0`
 *
 * Hoisted here so sidebars rendering N workspace rows don't multiply the
 * number of concurrent `git_sync`/`git_push` calls on startup and focus.
 */
export function useAppGitFocus() {
  const activePath = useWorkspaceStore((s) => selectActiveWorkspacePath(s));
  const lastSynced = useRef<string | null>(null);

  // Silent sync-on-open for the active workspace only.
  useEffect(() => {
    if (!activePath) return;
    if (lastSynced.current === activePath) return;
    lastSynced.current = activePath;
    void syncOnOpen(activePath);
  }, [activePath]);

  // Single window-focus listener that refreshes status for the active
  // workspace and auto-pushes any unpushed commits.
  useEffect(() => {
    const onFocus = async () => {
      const path = selectActiveWorkspacePath(useWorkspaceStore.getState());
      if (!path) return;
      try {
        const status = await invoke<WorkspaceGitStatus>("git_status", {
          workspacePath: path,
        });
        useGitStore.getState().applyStatus(path, status);
        if (status.ahead > 0 && status.tracking) {
          try {
            const pushed = await invoke<WorkspaceGitStatus>("git_push", {
              workspacePath: path,
            });
            useGitStore.getState().applyStatus(path, pushed);
          } catch (err) {
            console.debug("auto-push on focus failed:", err);
          }
        }
      } catch (err) {
        console.debug("git_status on focus failed:", err);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
