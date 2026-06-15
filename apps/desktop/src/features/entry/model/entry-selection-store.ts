import { create } from "zustand";

interface EntrySelectionState {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  openDocument: (path: string, spaceId?: string) => void;
  closeDocument: () => void;
}

export const useEntrySelectionStore = create<EntrySelectionState>((set) => ({
  activeDocument: null,
  activeDocumentSpaceId: null,

  openDocument: (path, spaceId?) =>
    set((state) => ({
      activeDocument: path,
      activeDocumentSpaceId: spaceId ?? state.activeDocumentSpaceId,
    })),

  closeDocument: () =>
    set({ activeDocument: null, activeDocumentSpaceId: null }),
}));
