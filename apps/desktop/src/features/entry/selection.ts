export {
  closeEntryDocument,
  getActiveEntrySelection,
  openEntryDocument,
  openEntryScopeHome,
  type EntryRevealRequest,
  type EntrySelectionSnapshot,
  type OpenEntryDocumentOptions,
} from "./hooks/entry-selection-actions";
export {
  useActiveEntryDocument,
  useActiveEntryDocumentSpaceId,
  useActiveEntrySelection,
  useCloseEntryDocument,
  useOpenEntryDocument,
  useOpenEntryScopeHome,
} from "./hooks/use-entry-selection";
