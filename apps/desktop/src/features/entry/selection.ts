export {
  closeEntryDocument,
  getActiveEntrySelection,
  openEntryDocument,
  openEntryScopeHome,
  publishEntryTitleOutcome,
  retargetEntryDocument,
  type EntryPathRetarget,
  type EntryRevealRequest,
  type EntrySelectionSnapshot,
  type EntryTitleOutcome,
  type OpenEntryDocumentOptions,
} from "./hooks/entry-selection-actions";
export {
  useActiveEntryDocument,
  useActiveEntryDocumentSpaceId,
  useActiveEntrySelection,
  useCloseEntryDocument,
  useEntryTitleOutcome,
  useEntryTitleOutcomeEffect,
  useOpenEntryDocument,
  useOpenEntryScopeHome,
  useRetargetEntryDocument,
} from "./hooks/use-entry-selection";
