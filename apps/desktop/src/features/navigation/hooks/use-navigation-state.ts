import { useEffect, useLayoutEffect } from "react";
import { useStore } from "zustand";
import {
  forgetNavigationItems,
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
  listenNavigationChanged,
  pinNavigationItem,
  readNavigationState,
} from "../api/navigation";
import {
  createNavigationStore,
  type NavigationStoreState,
} from "../model/navigation-store";

/** File events come in bursts; one read resolves them all. */
const SOURCE_CHANGE_DEBOUNCE_MS = 400;

const navigationStore = createNavigationStore({
  read: readNavigationState,
  pin: pinNavigationItem,
  forget: forgetNavigationItems,
});

/**
 * Binds the navigation state to the open project and reads it again when
 * the sources of pinned targets may have changed: Desktop moved pins, files
 * changed, the registered Spaces changed (`spacesKey`), or the window came
 * back to the foreground. Mount once in app composition.
 */
export function useNavigationStateLifecycle(
  projectPath: string | null,
  spacesKey: string,
) {
  useLayoutEffect(() => {
    navigationStore.getState().setProject(projectPath);
  }, [projectPath]);

  useEffect(() => {
    if (projectPath) void navigationStore.getState().refresh();
  }, [projectPath, spacesKey]);

  useEffect(() => {
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void navigationStore.getState().refresh();
      }, SOURCE_CHANGE_DEBOUNCE_MS);
    };
    const refreshNow = () => {
      if (document.visibilityState === "visible") {
        void navigationStore.getState().refresh();
      }
    };
    const subscriptions = [
      listenNavigationChanged(refreshNow),
      listenFileCreated(refreshSoon),
      listenFileChanged(refreshSoon),
      listenFileDeleted(refreshSoon),
    ];
    document.addEventListener("visibilitychange", refreshNow);
    window.addEventListener("focus", refreshNow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshNow);
      window.removeEventListener("focus", refreshNow);
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, [projectPath]);
}

export function useNavigationState<T>(
  selector: (state: NavigationStoreState) => T,
): T {
  return useStore(navigationStore, selector);
}

export function getNavigationState(): NavigationStoreState {
  return navigationStore.getState();
}
