import {
  useEntrySelectionStore,
  type EntryRevealRequest,
  type OpenEntryDocumentOptions,
  type ScopeOpenRequest,
} from "./entry-selection-store";

export type {
  EntryRevealRequest,
  OpenEntryDocumentOptions,
  ScopeOpenRequest,
} from "./entry-selection-store";

export interface EntrySelectionSnapshot {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  activeScopeOpenRequest: ScopeOpenRequest | null;
}

export function getActiveEntrySelection(): EntrySelectionSnapshot {
  const {
    activeDocument,
    activeDocumentSpaceId,
    activeRevealRequest,
    activeScopeOpenRequest,
  } = useEntrySelectionStore.getState();
  return {
    activeDocument,
    activeDocumentSpaceId,
    activeRevealRequest,
    activeScopeOpenRequest,
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

export function closeEntryDocument() {
  useEntrySelectionStore.getState().closeDocument();
}
