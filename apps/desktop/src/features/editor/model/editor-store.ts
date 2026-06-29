import { create } from "zustand";
import { editorFileKey, editorFileKeysForClear } from "./editor-file-keys";

interface EditorState {
  /** Tracks pending editor writes per scoped file key. */
  unsavedChanges: Record<string, boolean>;
  /** Tracks external edits for editor reload/cache behavior. */
  aiModified: Record<string, boolean>;
  /** Cache-invalidation-only flag: forces Plate to re-read from disk on next open. No visual side effect. */
  staleCache: Record<string, boolean>;
  /** Pending title rename from sidebar — editor picks it up and applies */
  pendingRename: {
    scopePath: string;
    path: string;
    title: string;
    newPath: string | null;
  } | null;
  /** Set of broken link target paths for the currently open document */
  brokenLinks: Set<string>;
  /** Paths to ignore in file watcher events (structural operations, auto-cleared after timeout) */
  suppressedPaths: Set<string>;

  markUnsaved: (scopePath: string | null | undefined, path: string) => void;
  clearUnsaved: (scopePath: string | null | undefined, path: string) => void;
  hasUnsaved: (scopePath: string | null | undefined, path: string) => boolean;
  markAiModified: (scopePath: string | null | undefined, path: string) => void;
  clearAiModified: (scopePath: string | null | undefined, path: string) => void;
  hasAiModified: (
    scopePath: string | null | undefined,
    path: string,
  ) => boolean;
  markStale: (scopePath: string | null | undefined, path: string) => void;
  clearStale: (scopePath: string | null | undefined, path: string) => void;
  hasStale: (scopePath: string | null | undefined, path: string) => boolean;
  hasIndicator: (scopePath: string | null | undefined, path: string) => boolean;
  /** Suppress file watcher indicators for these paths (auto-cleared after 2s) */
  suppressPaths: (
    scopePath: string | null | undefined,
    paths: string[],
  ) => void;
  /** Returns true if the path is currently suppressed */
  isSuppressed: (scopePath: string | null | undefined, path: string) => boolean;
  requestRename: (
    scopePath: string | null | undefined,
    path: string,
    title: string,
    newPath: string | null,
  ) => void;
  clearPendingRename: () => void;
  setBrokenLinks: (links: Set<string>) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  unsavedChanges: {},
  aiModified: {},
  staleCache: {},
  pendingRename: null,
  brokenLinks: new Set<string>(),
  suppressedPaths: new Set<string>(),

  markUnsaved: (scopePath, path) =>
    set((s) => ({
      unsavedChanges: {
        ...s.unsavedChanges,
        [editorFileKey(scopePath, path)]: true,
      },
    })),

  clearUnsaved: (scopePath, path) =>
    set((s) => ({
      unsavedChanges: removeEditorFileKeys(s.unsavedChanges, scopePath, path),
    })),

  hasUnsaved: (scopePath, path) =>
    !!get().unsavedChanges[editorFileKey(scopePath, path)],

  markAiModified: (scopePath, path) =>
    set((s) => ({
      aiModified: {
        ...s.aiModified,
        [editorFileKey(scopePath, path)]: true,
      },
    })),

  clearAiModified: (scopePath, path) =>
    set((s) => ({
      aiModified: removeEditorFileKeys(s.aiModified, scopePath, path),
    })),

  hasAiModified: (scopePath, path) =>
    !!get().aiModified[editorFileKey(scopePath, path)],

  markStale: (scopePath, path) =>
    set((s) => ({
      staleCache: { ...s.staleCache, [editorFileKey(scopePath, path)]: true },
    })),

  clearStale: (scopePath, path) =>
    set((s) => ({
      staleCache: removeEditorFileKeys(s.staleCache, scopePath, path),
    })),

  hasStale: (scopePath, path) =>
    !!get().staleCache[editorFileKey(scopePath, path)],

  hasIndicator: (scopePath, path) => {
    const { unsavedChanges, aiModified } = get();
    const key = editorFileKey(scopePath, path);
    return !!unsavedChanges[key] || !!aiModified[key];
  },

  suppressPaths: (scopePath, paths) => {
    set((s) => {
      const next = new Set(s.suppressedPaths);
      for (const p of paths) next.add(editorFileKey(scopePath, p));
      return { suppressedPaths: next };
    });
    // Auto-clear after 2s to catch all FS events from the operation
    setTimeout(() => {
      set((s) => {
        const next = new Set(s.suppressedPaths);
        for (const p of paths) {
          for (const key of editorFileKeysForClear(scopePath, p)) {
            next.delete(key);
          }
        }
        return { suppressedPaths: next };
      });
    }, 2000);
  },

  isSuppressed: (scopePath, path) =>
    get().suppressedPaths.has(editorFileKey(scopePath, path)),

  requestRename: (scopePath, path, title, newPath) =>
    set({
      pendingRename: {
        scopePath: (scopePath ?? "").replaceAll("\\", "/").replace(/\/+$/g, ""),
        path,
        title,
        newPath,
      },
    }),
  clearPendingRename: () => set({ pendingRename: null }),
  setBrokenLinks: (links) => set({ brokenLinks: links }),
}));

function removeEditorFileKeys(
  record: Record<string, boolean>,
  scopePath: string | null | undefined,
  path: string,
): Record<string, boolean> {
  const keys = editorFileKeysForClear(scopePath, path);
  if (keys.every((key) => record[key] === undefined)) return record;
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}
