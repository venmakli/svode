import { create } from "zustand";

export interface EntrySelectionState {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  openDocument: (path: string, spaceId?: string) => void;
  openScopeHome: (spaceId?: string) => void;
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

  openScopeHome: (spaceId?) =>
    set({ activeDocument: null, activeDocumentSpaceId: spaceId ?? null }),

  closeDocument: () =>
    set({ activeDocument: null, activeDocumentSpaceId: null }),
}));
