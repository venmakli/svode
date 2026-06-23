import { useEntrySelectionStore } from "./entry-selection-store";

export interface EntrySelectionSnapshot {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
}

export function getActiveEntrySelection(): EntrySelectionSnapshot {
  const { activeDocument, activeDocumentSpaceId } =
    useEntrySelectionStore.getState();
  return { activeDocument, activeDocumentSpaceId };
}

export function openEntryDocument(path: string, spaceId?: string) {
  useEntrySelectionStore.getState().openDocument(path, spaceId);
}

export function openEntryScopeHome(spaceId?: string) {
  useEntrySelectionStore.getState().openScopeHome(spaceId);
}

export function closeEntryDocument() {
  useEntrySelectionStore.getState().closeDocument();
}
