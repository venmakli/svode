import { useShallow } from "zustand/shallow";
import type { EntrySelectionSnapshot } from "./entry-selection-actions";
import { useEntrySelectionStore } from "./entry-selection-store";

export function useActiveEntrySelection(): EntrySelectionSnapshot {
  return useEntrySelectionStore(
    useShallow(
      (state): EntrySelectionSnapshot => ({
        activeDocument: state.activeDocument,
        activeDocumentSpaceId: state.activeDocumentSpaceId,
        activeRevealRequest: state.activeRevealRequest,
      }),
    ),
  );
}

export function useActiveEntryDocument() {
  return useEntrySelectionStore((state) => state.activeDocument);
}

export function useActiveEntryDocumentSpaceId() {
  return useEntrySelectionStore((state) => state.activeDocumentSpaceId);
}

export function useOpenEntryDocument() {
  return useEntrySelectionStore((state) => state.openDocument);
}

export function useOpenEntryScopeHome() {
  return useEntrySelectionStore((state) => state.openScopeHome);
}

export function useCloseEntryDocument() {
  return useEntrySelectionStore((state) => state.closeDocument);
}
