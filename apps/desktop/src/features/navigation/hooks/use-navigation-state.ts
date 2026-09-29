import { useLayoutEffect } from "react";
import { useStore } from "zustand";
import {
  forgetNavigationItems,
  pinNavigationItem,
  readNavigationState,
} from "../api/navigation";
import {
  createNavigationStore,
  type NavigationStoreState,
} from "../model/navigation-store";

const navigationStore = createNavigationStore({
  read: readNavigationState,
  pin: pinNavigationItem,
  forget: forgetNavigationItems,
});

/** Binds the navigation state to the open project. Mount once in app composition. */
export function useNavigationStateLifecycle(projectPath: string | null) {
  useLayoutEffect(() => {
    navigationStore.getState().setProject(projectPath);
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
