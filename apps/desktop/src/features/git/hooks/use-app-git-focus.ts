import { useEffect, useRef } from "react";
import {
  getSpaceSnapshot,
  useSpace,
  selectActiveSpacePath,
} from "@/features/space";
import {
  refreshGitOnWindowFocus,
  syncGitOnActiveSpaceOpen,
} from "../api/git-focus-actions";

/**
 * App-level git hooks that run once for the currently-active space:
 *  - `syncOnOpen` on space switch (silent pull+push if remote configured)
 *  - window `focus` → status refresh; auto-push only when auto-sync is enabled
 *
 * Hoisted here so sidebars rendering N space rows don't multiply the
 * number of concurrent sync/push calls on startup and focus.
 */
export function useAppGitFocus() {
  const activePath = useSpace((s) => selectActiveSpacePath(s));
  const lastSynced = useRef<string | null>(null);

  // Silent sync-on-open for the active space only.
  useEffect(() => {
    if (!activePath) return;
    if (lastSynced.current === activePath) return;
    lastSynced.current = activePath;
    void syncGitOnActiveSpaceOpen(activePath);
  }, [activePath]);

  // Single window-focus listener that refreshes status for the active space.
  // Background network writes obey the same auto-sync policy as commit paths.
  useEffect(() => {
    const onFocus = async () => {
      const path = selectActiveSpacePath(getSpaceSnapshot());
      if (!path) return;
      await refreshGitOnWindowFocus(path);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
