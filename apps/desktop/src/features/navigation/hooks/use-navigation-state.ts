import { useContext, useEffect, useLayoutEffect, useState } from "react";
import { useStore } from "zustand";
import {
  forgetNavigationItems,
  keepNavigationItem,
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
  listenNavigationChanged,
  pinNavigationItem,
  readNavigationState,
  retitleNavigationItem,
  unkeepNavigationItems,
  unpinNavigationItems,
} from "../api/navigation";
import {
  createNavigationStore,
  type NavigationStateApi,
  type NavigationStore,
  type NavigationStoreState,
} from "../model/navigation-store";
import { NavigationStoreContext } from "./navigation-store-context";

/** File events come in bursts; one read resolves them all. */
const SOURCE_CHANGE_DEBOUNCE_MS = 400;

const navigationApi: NavigationStateApi = {
  read: readNavigationState,
  pin: pinNavigationItem,
  keep: keepNavigationItem,
  unpin: unpinNavigationItems,
  unkeep: unkeepNavigationItems,
  forget: forgetNavigationItems,
  retitle: retitleNavigationItem,
};

const navigationStore = createNavigationStore(navigationApi);

/**
 * Binds the navigation state to the open project and reads it again when
 * the sources of pinned and kept targets may have changed: Desktop moved pins, files
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

/**
 * The navigation state of a project other than the open one, through the
 * same Desktop owner; read when the project is bound and on `refresh`. It
 * follows no file events: the project has no window here.
 */
export function useProjectNavigationStore(
  projectPath: string,
): NavigationStore {
  const [store] = useState(() => createNavigationStore(navigationApi));
  useLayoutEffect(() => {
    store.getState().setProject(projectPath);
  }, [projectPath, store]);
  return store;
}

/** The open project's state, or the one a `NavigationStoreProvider` binds. */
export function useNavigationState<T>(
  selector: (state: NavigationStoreState) => T,
): T {
  const store = useContext(NavigationStoreContext) ?? navigationStore;
  return useStore(store, selector);
}

export function getNavigationState(): NavigationStoreState {
  return navigationStore.getState();
}
