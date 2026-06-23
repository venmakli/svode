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

export function createFileTreeEditorSync(spaceId: string): FileTreeEditorSync {
  const initialActiveDocument = getActiveEntrySelection().activeDocument;

  return {
    initialActiveDocument,
    suppressPaths: (paths) => {
      suppressEditorFileEvents(paths);
    },
    clearInitialUnsaved: (path) => {
      if (initialActiveDocument === path) {
        clearEditorFileUnsaved(path);
      }
    },
    reopenInitialDocument: (fromPath, toPath) => {
      if (initialActiveDocument !== fromPath) return;
      clearEditorFileUnsaved(fromPath);
      openEntryDocument(toPath, spaceId);
    },
    activeDocument: () => getActiveEntrySelection().activeDocument,
    reopenDocumentSnapshot: (activeDocument, fromPath, toPath) => {
      if (activeDocument !== fromPath) return;
      clearEditorFileUnsaved(fromPath);
      openEntryDocument(toPath, spaceId);
    },
  };
}
