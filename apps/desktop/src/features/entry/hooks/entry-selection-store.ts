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

export interface EntryPathRetarget {
  key: number;
  fromPath: string;
  path: string;
  spaceId: string | null;
}

export interface EntrySelectionState {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  activeScopeOpenRequest: ScopeOpenRequest | null;
  activePathRetarget: EntryPathRetarget | null;
  openDocument: (
    path: string,
    spaceId?: string,
    options?: OpenEntryDocumentOptions,
  ) => void;
  openScopeHome: (spaceId?: string) => void;
  retargetDocument: (fromPath: string, path: string, spaceId?: string) => void;
  closeDocument: () => void;
}

let nextRevealRequestKey = 1;
let nextScopeOpenRequestKey = 1;
let nextPathRetargetKey = 1;

export const useEntrySelectionStore = create<EntrySelectionState>((set) => ({
  activeDocument: null,
  activeDocumentSpaceId: null,
  activeRevealRequest: null,
  activeScopeOpenRequest: null,
  activePathRetarget: null,

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
        activePathRetarget: null,
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
        activePathRetarget: null,
      };
    }),

  retargetDocument: (fromPath, path, spaceId?) =>
    set((state) => {
      const targetSpaceId = spaceId ?? state.activeDocumentSpaceId;
      if (
        state.activeDocument !== fromPath ||
        state.activeDocumentSpaceId !== targetSpaceId ||
        fromPath === path
      ) {
        return state;
      }
      return {
        activeDocument: path,
        activeDocumentSpaceId: targetSpaceId,
        activeRevealRequest:
          state.activeRevealRequest?.path === fromPath &&
          state.activeRevealRequest.spaceId === targetSpaceId
            ? { ...state.activeRevealRequest, path }
            : state.activeRevealRequest,
        activeScopeOpenRequest: state.activeScopeOpenRequest,
        activePathRetarget: {
          key: nextPathRetargetKey++,
          fromPath,
          path,
          spaceId: targetSpaceId ?? null,
        },
      };
    }),

  closeDocument: () =>
    set({
      activeDocument: null,
      activeDocumentSpaceId: null,
      activeRevealRequest: null,
      activeScopeOpenRequest: null,
      activePathRetarget: null,
    }),
}));
