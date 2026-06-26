import {
  useEntrySelectionStore,
  type EntryRevealRequest,
  type OpenEntryDocumentOptions,
} from "./entry-selection-store";

export type { EntryRevealRequest, OpenEntryDocumentOptions };

export interface EntrySelectionSnapshot {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
}

export function getActiveEntrySelection(): EntrySelectionSnapshot {
  const { activeDocument, activeDocumentSpaceId, activeRevealRequest } =
    useEntrySelectionStore.getState();
  return { activeDocument, activeDocumentSpaceId, activeRevealRequest };
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
