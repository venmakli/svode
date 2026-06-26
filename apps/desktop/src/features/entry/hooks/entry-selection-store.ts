import { create } from "zustand";

export interface EntryRevealRequest {
  key: number;
  path: string;
  spaceId: string | null;
}

export interface OpenEntryDocumentOptions {
  reveal?: boolean;
}

export interface EntrySelectionState {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  openDocument: (
    path: string,
    spaceId?: string,
    options?: OpenEntryDocumentOptions,
  ) => void;
  openScopeHome: (spaceId?: string) => void;
  closeDocument: () => void;
}

let nextRevealRequestKey = 1;

export const useEntrySelectionStore = create<EntrySelectionState>((set) => ({
  activeDocument: null,
  activeDocumentSpaceId: null,
  activeRevealRequest: null,

  openDocument: (path, spaceId?, options?) =>
    set((state) => ({
      activeDocument: path,
      activeDocumentSpaceId: spaceId ?? state.activeDocumentSpaceId,
      activeRevealRequest: options?.reveal
        ? {
            key: nextRevealRequestKey++,
            path,
            spaceId: spaceId ?? state.activeDocumentSpaceId ?? null,
          }
        : null,
    })),

  openScopeHome: (spaceId?) =>
    set({
      activeDocument: null,
      activeDocumentSpaceId: spaceId ?? null,
      activeRevealRequest: null,
    }),

  closeDocument: () =>
    set({
      activeDocument: null,
      activeDocumentSpaceId: null,
      activeRevealRequest: null,
    }),
}));
