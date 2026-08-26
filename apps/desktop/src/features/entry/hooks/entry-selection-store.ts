import { create } from "zustand";
import type { ScopeOpenIntent } from "@/features/scope-surfaces";
import type { Entry } from "../model";

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

export interface EntryTitleOutcome {
  key: number;
  scopePath: string;
  previousPath: string;
  entry: Entry;
}

export interface EntrySelectionState {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  activeScopeOpenRequest: ScopeOpenRequest | null;
  activePathRetarget: EntryPathRetarget | null;
  titleOutcomeBySourceKey: Record<string, EntryTitleOutcome>;
  openDocument: (
    path: string,
    spaceId?: string,
    options?: OpenEntryDocumentOptions,
  ) => void;
  openScopeHome: (spaceId?: string) => void;
  retargetDocument: (fromPath: string, path: string, spaceId?: string) => void;
  publishTitleOutcome: (
    scopePath: string,
    previousPath: string,
    entry: Entry,
  ) => void;
  closeDocument: () => void;
}

let nextRevealRequestKey = 1;
let nextScopeOpenRequestKey = 1;
let nextPathRetargetKey = 1;
let nextTitleOutcomeKey = 1;

function normalizeEntryIdentityPart(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/g, "");
}

export function entryTitleOutcomeSourceKey(scopePath: string, path: string) {
  return `${normalizeEntryIdentityPart(scopePath)}\0${normalizeEntryIdentityPart(path)}`;
}

export const useEntrySelectionStore = create<EntrySelectionState>((set) => ({
  activeDocument: null,
  activeDocumentSpaceId: null,
  activeRevealRequest: null,
  activeScopeOpenRequest: null,
  activePathRetarget: null,
  titleOutcomeBySourceKey: {},

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

  publishTitleOutcome: (scopePath, previousPath, entry) =>
    set((state) => ({
      titleOutcomeBySourceKey: {
        ...state.titleOutcomeBySourceKey,
        [entryTitleOutcomeSourceKey(scopePath, previousPath)]: {
          key: nextTitleOutcomeKey++,
          scopePath: normalizeEntryIdentityPart(scopePath),
          previousPath,
          entry,
        },
      },
    })),

  closeDocument: () =>
    set({
      activeDocument: null,
      activeDocumentSpaceId: null,
      activeRevealRequest: null,
      activeScopeOpenRequest: null,
      activePathRetarget: null,
    }),
}));
