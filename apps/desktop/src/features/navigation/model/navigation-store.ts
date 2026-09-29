import { createStore, type StoreApi } from "zustand/vanilla";
import type { NavigationStateDto } from "../api/navigation";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
} from "./keys";

/** Desktop navigation state commands the store depends on. */
export interface NavigationStateApi {
  read: (projectPath: string) => Promise<NavigationStateDto>;
  pin: (
    projectPath: string,
    item: NavigationItem,
  ) => Promise<NavigationStateDto>;
  forget: (
    projectPath: string,
    keys: NavigationKey[],
  ) => Promise<NavigationStateDto>;
}

export interface NavigationStoreState {
  projectPath: string | null;
  /** Pinned objects in pin order. */
  pinned: NavigationItem[];
  loaded: boolean;
  /** Key ids with a pin or unpin in flight. */
  pendingKeyIds: ReadonlySet<string>;

  setProject: (projectPath: string | null) => void;
  pin: (item: NavigationItem) => Promise<void>;
  unpin: (key: NavigationKey) => Promise<void>;
  /** Drops targets whose absence a successful read of their source confirmed. */
  forget: (keys: NavigationKey[]) => Promise<void>;
}

export type NavigationStore = StoreApi<NavigationStoreState>;

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Frontend view of the project navigation state owned by Desktop. Every
 * change is a backend operation whose answer is the whole state; a later
 * answer never gives way to an earlier one.
 */
export function createNavigationStore(
  api: NavigationStateApi,
): NavigationStore {
  let generation = 0;
  let requested = 0;
  let applied = 0;

  return createStore<NavigationStoreState>((set, get) => {
    function current(token: number, projectPath: string) {
      return token === generation && get().projectPath === projectPath;
    }

    async function run(
      operation: (projectPath: string) => Promise<NavigationStateDto>,
      keyIds: string[] = [],
    ) {
      const projectPath = get().projectPath;
      if (!projectPath) return;
      const token = generation;
      const request = ++requested;
      setPending(keyIds, true);
      try {
        const state = await operation(projectPath);
        if (current(token, projectPath) && request > applied) {
          applied = request;
          set({ pinned: state.pinned, loaded: true });
        }
      } finally {
        if (current(token, projectPath)) setPending(keyIds, false);
      }
    }

    function setPending(keyIds: string[], pending: boolean) {
      if (keyIds.length === 0) return;
      const next = new Set(get().pendingKeyIds);
      for (const id of keyIds) {
        if (pending) next.add(id);
        else next.delete(id);
      }
      set({ pendingKeyIds: next });
    }

    return {
      projectPath: null,
      pinned: [],
      loaded: false,
      pendingKeyIds: EMPTY_SET,

      setProject: (projectPath) => {
        if (projectPath === get().projectPath) return;
        generation += 1;
        applied = requested;
        set({
          projectPath,
          pinned: [],
          loaded: false,
          pendingKeyIds: EMPTY_SET,
        });
        if (!projectPath) return;
        void run(api.read).catch((error: unknown) => {
          console.error("Failed to read navigation state:", error);
        });
      },

      pin: (item) =>
        run(
          (projectPath) => api.pin(projectPath, item),
          [navigationKeyId(item.key)],
        ),

      unpin: (key) =>
        run(
          (projectPath) => api.forget(projectPath, [key]),
          [navigationKeyId(key)],
        ),

      forget: async (keys) => {
        if (keys.length === 0) return;
        await run((projectPath) => api.forget(projectPath, keys)).catch(
          (error: unknown) => {
            console.error("Failed to forget navigation items:", error);
          },
        );
      },
    };
  });
}
