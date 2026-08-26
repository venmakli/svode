export {
  closeEntryDocument,
  getActiveEntrySelection,
  openEntryDocument,
  openEntryScopeHome,
  retargetEntryDocument,
  type EntryPathRetarget,
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
  useRetargetEntryDocument,
} from "./hooks/use-entry-selection";
