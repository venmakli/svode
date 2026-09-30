import { createStore, type StoreApi } from "zustand/vanilla";
import type { NavigationStateDto } from "../api/navigation";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
  type NavigationResolvedItem,
} from "./keys";

/** Desktop navigation state commands the store depends on. */
export interface NavigationStateApi {
  read: (projectPath: string) => Promise<NavigationStateDto>;
  pin: (
    projectPath: string,
    item: NavigationItem,
  ) => Promise<NavigationStateDto>;
  keep: (
    projectPath: string,
    item: NavigationItem,
  ) => Promise<NavigationStateDto>;
  unpin: (
    projectPath: string,
    keys: NavigationKey[],
  ) => Promise<NavigationStateDto>;
  unkeep: (
    projectPath: string,
    keys: NavigationKey[],
  ) => Promise<NavigationStateDto>;
  forget: (
    projectPath: string,
    keys: NavigationKey[],
  ) => Promise<NavigationStateDto>;
  retitle: (
    projectPath: string,
    item: NavigationItem,
  ) => Promise<NavigationStateDto>;
}

export interface NavigationStoreState {
  projectPath: string | null;
  /** Pinned objects in pin order, as their sources were last read. */
  pinned: NavigationResolvedItem[];
  /** Objects kept in Now in keep order; never also pinned. */
  kept: NavigationResolvedItem[];
  loaded: boolean;
  /** Grows with every applied answer: Desktop resolved the sources again. */
  revision: number;
  /** Key ids with a pin, keep or removal in flight. */
  pendingKeyIds: ReadonlySet<string>;

  setProject: (projectPath: string | null) => void;
  /** Reads the state again; Desktop resolves the targets against their sources. */
  refresh: () => Promise<void>;
  pin: (item: NavigationItem) => Promise<void>;
  unpin: (key: NavigationKey) => Promise<void>;
  /** Keeps the object in Now; a pinned object stays pinned. */
  keep: (item: NavigationItem) => Promise<void>;
  /** Removes the objects from Now. */
  unkeep: (keys: NavigationKey[]) => Promise<void>;
  /** Drops targets whose absence a successful read of their source confirmed. */
  forget: (keys: NavigationKey[]) => Promise<void>;
  /** Refreshes the last known title of a pinned or kept object. */
  retitle: (item: NavigationItem) => Promise<void>;
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
          set({
            pinned: state.pinned,
            kept: state.kept,
            loaded: true,
            revision: get().revision + 1,
          });
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

    // The stored key is the one removed: it may record an older form of the
    // same artifact.
    function storedKeys(
      items: readonly NavigationResolvedItem[],
      keys: readonly NavigationKey[],
    ): NavigationKey[] {
      return keys.map((key) => {
        const id = navigationKeyId(key);
        return (
          items.find((item) => navigationKeyId(item.key) === id)?.key ?? key
        );
      });
    }

    return {
      projectPath: null,
      pinned: [],
      kept: [],
      loaded: false,
      revision: 0,
      pendingKeyIds: EMPTY_SET,

      setProject: (projectPath) => {
        if (projectPath === get().projectPath) return;
        generation += 1;
        applied = requested;
        set({
          projectPath,
          pinned: [],
          kept: [],
          loaded: false,
          pendingKeyIds: EMPTY_SET,
        });
        if (!projectPath) return;
        void get().refresh();
      },

      refresh: () =>
        run(api.read).catch((error: unknown) => {
          console.error("Failed to read navigation state:", error);
        }),

      pin: (item) =>
        run(
          (projectPath) => api.pin(projectPath, item),
          [navigationKeyId(item.key)],
        ),

      unpin: (key) => {
        const stored = storedKeys(get().pinned, [key]);
        return run(
          (projectPath) => api.unpin(projectPath, stored),
          [navigationKeyId(key)],
        );
      },

      keep: (item) =>
        run(
          (projectPath) => api.keep(projectPath, item),
          [navigationKeyId(item.key)],
        ),

      unkeep: (keys) => {
        if (keys.length === 0) return Promise.resolve();
        const stored = storedKeys(get().kept, keys);
        return run(
          (projectPath) => api.unkeep(projectPath, stored),
          keys.map(navigationKeyId),
        );
      },

      retitle: (item) => run((projectPath) => api.retitle(projectPath, item)),

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
