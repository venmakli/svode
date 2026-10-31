import { listenPublicationOutcomes } from "../api/git-publication-actions";
import { listenGitOperationOutcomes } from "../api/git-operation-events";
import { listenAutoVersionOutcomes } from "../api/git-auto-version-actions";
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
 * App-level git hooks that run once for the currently-active space; the
 * sync rhythm decides what each action does (Stage 11 1.E):
 *  - opening the Space, also at start, checks incoming when sync is on;
 *  - window `focus` checks incoming, or fetches the counters with sync off.
 *
 * Hoisted here so sidebars rendering N space rows don't multiply the
 * number of actions on startup and focus.
 */
export function useAppGitFocus() {
  const activePath = useSpace((s) => selectActiveSpacePath(s));
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    for (const listen of [
      listenPublicationOutcomes,
      listenGitOperationOutcomes,
      listenAutoVersionOutcomes,
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

  // Opening the active Space is an action of the rhythm.
  useEffect(() => {
    if (!activePath) return;
    void syncGitOnActiveSpaceOpen(activePath);
  }, [activePath]);

  // Single window-focus listener for the active space.
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
