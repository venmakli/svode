import { create } from "zustand";

interface EditorState {
  /** Tracks unsaved user edits per file path */
  unsavedChanges: Record<string, boolean>;
  /** Tracks files modified externally (AI/IDE) that user hasn't viewed — drives the blue dot */
  aiModified: Record<string, boolean>;
  /** Cache-invalidation-only flag: forces Plate to re-read from disk on next open. No visual side effect. */
  staleCache: Record<string, boolean>;
  /** Pending title rename from sidebar — editor picks it up and applies */
  pendingRename: { path: string; title: string; newPath: string | null } | null;
  /** Set of broken link target paths for the currently open document */
  brokenLinks: Set<string>;
  /** Paths to ignore in file watcher events (structural operations, auto-cleared after timeout) */
  suppressedPaths: Set<string>;

  markUnsaved: (path: string) => void;
  clearUnsaved: (path: string) => void;
  markAiModified: (path: string) => void;
  clearAiModified: (path: string) => void;
  markStale: (path: string) => void;
  clearStale: (path: string) => void;
  hasIndicator: (path: string) => boolean;
  /** Suppress file watcher indicators for these paths (auto-cleared after 2s) */
  suppressPaths: (paths: string[]) => void;
  /** Returns true if the path is currently suppressed */
  isSuppressed: (path: string) => boolean;
  requestRename: (path: string, title: string, newPath: string | null) => void;
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

  markUnsaved: (path) =>
    set((s) => ({
      unsavedChanges: { ...s.unsavedChanges, [path]: true },
    })),

  clearUnsaved: (path) =>
    set((s) => {
      const { [path]: _removed, ...rest } = s.unsavedChanges;
      return { unsavedChanges: rest };
    }),

  markAiModified: (path) =>
    set((s) => ({
      aiModified: { ...s.aiModified, [path]: true },
    })),

  clearAiModified: (path) =>
    set((s) => {
      const { [path]: _removed, ...rest } = s.aiModified;
      return { aiModified: rest };
    }),

  markStale: (path) =>
    set((s) => ({
      staleCache: { ...s.staleCache, [path]: true },
    })),

  clearStale: (path) =>
    set((s) => {
      const { [path]: _removed, ...rest } = s.staleCache;
      return { staleCache: rest };
    }),

  hasIndicator: (path) => {
    const { unsavedChanges, aiModified } = get();
    return !!unsavedChanges[path] || !!aiModified[path];
  },

  suppressPaths: (paths) => {
    set((s) => {
      const next = new Set(s.suppressedPaths);
      for (const p of paths) next.add(p);
      return { suppressedPaths: next };
    });
    // Auto-clear after 2s to catch all FS events from the operation
    setTimeout(() => {
      set((s) => {
        const next = new Set(s.suppressedPaths);
        for (const p of paths) next.delete(p);
        return { suppressedPaths: next };
      });
    }, 2000);
  },

  isSuppressed: (path) => get().suppressedPaths.has(path),

  requestRename: (path, title, newPath) => set({ pendingRename: { path, title, newPath } }),
  clearPendingRename: () => set({ pendingRename: null }),
  setBrokenLinks: (links) => set({ brokenLinks: links }),
}));
