import { listenPublicationOutcomes } from "../api/git-publication-actions";
import { listenGitOperationOutcomes } from "../api/git-operation-events";
import { useEffect } from "react";
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
  const activeRootPath = useSpace((s) => s.activeRootPath);
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    for (const listen of [
      listenPublicationOutcomes,
      listenGitOperationOutcomes,
    ]) {
      void listen().then((unlisten) => {
        if (disposed) unlisten();
        else stops.push(unlisten);
      });
    }
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);

  // Silent sync-on-open for the active space only.
  useEffect(() => {
    if (!activePath) return;
    void syncGitOnActiveSpaceOpen(activePath, activeRootPath);
  }, [activePath, activeRootPath]);

  // Single window-focus listener that refreshes status for the active space.
  // Background network writes obey the same auto-sync policy as commit paths.
  useEffect(() => {
    const onFocus = async () => {
      const path = selectActiveSpacePath(getSpaceSnapshot());
      const projectPath = getSpaceSnapshot().activeRootPath;
      if (!path) return;
      await refreshGitOnWindowFocus(path, projectPath);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
