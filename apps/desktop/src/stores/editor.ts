import { create } from "zustand";

interface EditorState {
  /** Tracks unsaved user edits per file path */
  unsavedChanges: Record<string, boolean>;
  /** Tracks files modified externally (AI/IDE) that user hasn't viewed */
  aiModified: Record<string, boolean>;

  markUnsaved: (path: string) => void;
  clearUnsaved: (path: string) => void;
  markAiModified: (path: string) => void;
  clearAiModified: (path: string) => void;
  hasIndicator: (path: string) => boolean;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  unsavedChanges: {},
  aiModified: {},

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
}));
