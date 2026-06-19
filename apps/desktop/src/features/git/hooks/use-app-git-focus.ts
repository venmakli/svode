import { useEffect, useRef } from "react";
import { useGitStore } from "../model";
import { useSpaceStore, selectActiveSpacePath } from "@/features/space/model";
import { getGitStatus, pushGit } from "@/platform/git/git-api";
import { isAutoSyncEnabled, syncOnOpen } from "../api/git-actions";

/**
 * App-level git hooks that run once for the currently-active space:
 *  - `syncOnOpen` on space switch (silent pull+push if remote configured)
 *  - window `focus` → status refresh; auto-push only when auto-sync is enabled
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

  // Single window-focus listener that refreshes status for the active space.
  // Background network writes obey the same auto-sync policy as commit paths.
  useEffect(() => {
    const onFocus = async () => {
      const path = selectActiveSpacePath(useSpaceStore.getState());
      if (!path) return;
      try {
        const status = await getGitStatus(path);
        useGitStore.getState().applyStatus(path, status);
        if (
          (await isAutoSyncEnabled(path)) &&
          status.ahead > 0 &&
          status.tracking
        ) {
          try {
            const pushed = await pushGit(path);
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
