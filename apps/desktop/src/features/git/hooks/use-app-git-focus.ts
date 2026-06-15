import { useEffect, useRef } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { useGitStore } from "../model";
import { useSpaceStore, selectActiveSpacePath } from "@/features/space";
import type { GitStatus } from "../model";
import { syncOnOpen } from "../api/git-actions";

/**
 * App-level git hooks that run once for the currently-active space:
 *  - `syncOnOpen` on space switch (silent pull+push if remote configured)
 *  - window `focus` → `git_status` + auto-push if `ahead > 0`
 *
 * Hoisted here so sidebars rendering N space rows don't multiply the
 * number of concurrent `git_sync`/`git_push` calls on startup and focus.
 */
export function useAppGitFocus() {
  const activePath = useSpaceStore((s) => selectActiveSpacePath(s));
  const lastSynced = useRef<string | null>(null);

  // Silent sync-on-open for the active space only.
  useEffect(() => {
    if (!activePath) return;
    if (lastSynced.current === activePath) return;
    lastSynced.current = activePath;
    void syncOnOpen(activePath);
  }, [activePath]);

  // Single window-focus listener that refreshes status for the active
  // space and auto-pushes any unpushed commits.
  useEffect(() => {
    const onFocus = async () => {
      const path = selectActiveSpacePath(useSpaceStore.getState());
      if (!path) return;
      try {
        const status = await invoke<GitStatus>("git_status", {
          spacePath: path,
        });
        useGitStore.getState().applyStatus(path, status);
        if (status.ahead > 0 && status.tracking) {
          try {
            const pushed = await invoke<GitStatus>("git_push", {
              spacePath: path,
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
