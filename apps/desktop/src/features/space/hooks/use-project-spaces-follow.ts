import { useEffect } from "react";
import { listenProjectSpaceChanges } from "../api/space-watch-actions";
import { useSpaceStore } from "../model";

/**
 * The Space lists of the window (sidebar, Settings → General → Spaces)
 * follow the Spaces of the active project as the app reconciles them with
 * its config on disk: after an operation of this window, a pull, or a change
 * by another process such as the `svode` CLI or an agent. Events of one
 * reconciliation read the list once more at most.
 */
export function useProjectSpacesFollow() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let reading = false;
    let again = false;

    const reload = async (projectPath: string) => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          await useSpaceStore.getState().loadSpaces(projectPath);
        } while (again && !disposed);
      } finally {
        reading = false;
      }
      const state = useSpaceStore.getState();
      if (
        state.activeRootPath === projectPath &&
        state.activeSpaceId &&
        !state.spaces.some((space) => space.id === state.activeSpaceId)
      ) {
        state.clearActiveSpace();
      }
    };

    listenProjectSpaceChanges(({ projectPath }) => {
      if (disposed) return;
      if (useSpaceStore.getState().activeRootPath !== projectPath) return;
      void reload(projectPath);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
