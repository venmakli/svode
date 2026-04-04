import { create } from "zustand";

interface EditorState {
  /** Tracks unsaved user edits per file path */
  unsavedChanges: Record<string, boolean>;
  /** Tracks files modified externally (AI/IDE) that user hasn't viewed */
  aiModified: Record<string, boolean>;
  /** Pending title rename from sidebar — editor picks it up and applies */
  pendingRename: { path: string; title: string; newPath: string | null } | null;
  /** Set of broken link target paths for the currently open document */
  brokenLinks: Set<string>;

  markUnsaved: (path: string) => void;
  clearUnsaved: (path: string) => void;
  markAiModified: (path: string) => void;
  clearAiModified: (path: string) => void;
  hasIndicator: (path: string) => boolean;
  requestRename: (path: string, title: string, newPath: string | null) => void;
  clearPendingRename: () => void;
  setBrokenLinks: (links: Set<string>) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  unsavedChanges: {},
  aiModified: {},
  pendingRename: null,
  brokenLinks: new Set<string>(),

  markUnsaved: (path) =>
    set((s) => ({
      unsavedChanges: { ...s.unsavedChanges, [path]: true },
    })),

  clearUnsaved: (path) =>
    set((s) => {
      const { [path]: _, ...rest } = s.unsavedChanges;
      return { unsavedChanges: rest };
    }),

  markAiModified: (path) =>
    set((s) => ({
      aiModified: { ...s.aiModified, [path]: true },
    })),

  clearAiModified: (path) =>
    set((s) => {
      const { [path]: _, ...rest } = s.aiModified;
      return { aiModified: rest };
    }),

  hasIndicator: (path) => {
    const { unsavedChanges, aiModified } = get();
    return !!unsavedChanges[path] || !!aiModified[path];
  },

  requestRename: (path, title, newPath) => set({ pendingRename: { path, title, newPath } }),
  clearPendingRename: () => set({ pendingRename: null }),
  setBrokenLinks: (links) => set({ brokenLinks: links }),
}));
