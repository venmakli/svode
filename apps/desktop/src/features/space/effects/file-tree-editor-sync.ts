import {
  getActiveEntrySelection,
  openEntryDocument,
} from "@/features/entry/selection";
import {
  clearEditorFileUnsaved,
  suppressEditorFileEvents,
} from "@/features/editor/file-tree-sync";

export interface FileTreeEditorSync {
  readonly initialActiveDocument: string | null;
  suppressPaths: (paths: string[]) => void;
  clearInitialUnsaved: (path: string) => void;
  reopenInitialDocument: (fromPath: string, toPath: string) => void;
  activeDocument: () => string | null;
  reopenDocumentSnapshot: (
    activeDocument: string | null,
    fromPath: string,
    toPath: string,
  ) => void;
}

export function createFileTreeEditorSync(
  spaceId: string,
  spacePath: string,
): FileTreeEditorSync {
  const initialSelection = getActiveEntrySelection();
  const initialActiveDocument = initialSelection.activeDocument;
  const initialActiveDocumentSpaceId = initialSelection.activeDocumentSpaceId;

  const isInitialDocument = (path: string) =>
    initialActiveDocumentSpaceId === spaceId && initialActiveDocument === path;

  return {
    initialActiveDocument,
    suppressPaths: (paths) => {
      suppressEditorFileEvents(spacePath, paths);
    },
    clearInitialUnsaved: (path) => {
      if (isInitialDocument(path)) {
        clearEditorFileUnsaved(spacePath, path);
      }
    },
    reopenInitialDocument: (fromPath, toPath) => {
      if (!isInitialDocument(fromPath)) return;
      clearEditorFileUnsaved(spacePath, fromPath);
      openEntryDocument(toPath, spaceId);
    },
    activeDocument: () => getActiveEntrySelection().activeDocument,
    reopenDocumentSnapshot: (activeDocument, fromPath, toPath) => {
      if (activeDocument !== fromPath) return;
      if (getActiveEntrySelection().activeDocumentSpaceId !== spaceId) return;
      clearEditorFileUnsaved(spacePath, fromPath);
      openEntryDocument(toPath, spaceId);
    },
  };
}
