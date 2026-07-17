import { create } from "zustand";
import type { ScopeOpenIntent } from "@/features/scope-surfaces";

export interface EntryRevealRequest {
  key: number;
  path: string;
  spaceId: string | null;
}

export interface OpenEntryDocumentOptions {
  reveal?: boolean;
  scopeOpenIntent?: ScopeOpenIntent;
}

export interface ScopeOpenRequest {
  key: number;
  intent: ScopeOpenIntent;
}

export interface EntrySelectionState {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  activeScopeOpenRequest: ScopeOpenRequest | null;
  openDocument: (
    path: string,
    spaceId?: string,
    options?: OpenEntryDocumentOptions,
  ) => void;
  openScopeHome: (spaceId?: string) => void;
  closeDocument: () => void;
}

let nextRevealRequestKey = 1;
let nextScopeOpenRequestKey = 1;

export const useEntrySelectionStore = create<EntrySelectionState>((set) => ({
  activeDocument: null,
  activeDocumentSpaceId: null,
  activeRevealRequest: null,
  activeScopeOpenRequest: null,

  openDocument: (path, spaceId?, options?) =>
    set((state) => {
      const targetSpaceId = spaceId ?? state.activeDocumentSpaceId;
      const isRepeatedSelection =
        state.activeDocument === path &&
        state.activeDocumentSpaceId === targetSpaceId &&
        !options?.reveal &&
        !options?.scopeOpenIntent;
      if (isRepeatedSelection) return state;
      return {
        activeDocument: path,
        activeDocumentSpaceId: targetSpaceId,
        activeRevealRequest: options?.reveal
          ? {
              key: nextRevealRequestKey++,
              path,
              spaceId: targetSpaceId ?? null,
            }
          : null,
        activeScopeOpenRequest: {
          key: nextScopeOpenRequestKey++,
          intent: options?.scopeOpenIntent ?? { kind: "default" },
        },
      };
    }),

  openScopeHome: (spaceId?) =>
    set((state) => {
      const targetSpaceId = spaceId ?? null;
      if (
        state.activeDocument === null &&
        state.activeDocumentSpaceId === targetSpaceId
      ) {
        return state;
      }
      return {
        activeDocument: null,
        activeDocumentSpaceId: targetSpaceId,
        activeRevealRequest: null,
        activeScopeOpenRequest: {
          key: nextScopeOpenRequestKey++,
          intent: { kind: "default" },
        },
      };
    }),

  closeDocument: () =>
    set({
      activeDocument: null,
      activeDocumentSpaceId: null,
      activeRevealRequest: null,
      activeScopeOpenRequest: null,
    }),
}));
