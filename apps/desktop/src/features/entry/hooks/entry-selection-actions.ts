import {
  useEntrySelectionStore,
  type EntryRevealRequest,
  type EntryPathRetarget,
  type OpenEntryDocumentOptions,
  type ScopeOpenRequest,
} from "./entry-selection-store";
import type { Entry } from "../model";

export type {
  EntryRevealRequest,
  EntryPathRetarget,
  EntryTitleOutcome,
  OpenEntryDocumentOptions,
  ScopeOpenRequest,
} from "./entry-selection-store";

export interface EntrySelectionSnapshot {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  activeScopeOpenRequest: ScopeOpenRequest | null;
  activePathRetarget: EntryPathRetarget | null;
}

export function getActiveEntrySelection(): EntrySelectionSnapshot {
  const {
    activeDocument,
    activeDocumentSpaceId,
    activeRevealRequest,
    activeScopeOpenRequest,
    activePathRetarget,
  } = useEntrySelectionStore.getState();
  return {
    activeDocument,
    activeDocumentSpaceId,
    activeRevealRequest,
    activeScopeOpenRequest,
    activePathRetarget,
  };
}

export function openEntryDocument(
  path: string,
  spaceId?: string,
  options?: OpenEntryDocumentOptions,
) {
  useEntrySelectionStore.getState().openDocument(path, spaceId, options);
}

export function openEntryScopeHome(spaceId?: string) {
  useEntrySelectionStore.getState().openScopeHome(spaceId);
}

export function retargetEntryDocument(
  fromPath: string,
  path: string,
  spaceId?: string,
) {
  useEntrySelectionStore.getState().retargetDocument(fromPath, path, spaceId);
}

export function publishEntryTitleOutcome(
  scopePath: string,
  previousPath: string,
  entry: Entry,
) {
  useEntrySelectionStore
    .getState()
    .publishTitleOutcome(scopePath, previousPath, entry);
}

export function closeEntryDocument() {
  useEntrySelectionStore.getState().closeDocument();
}
