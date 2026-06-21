import { useEntrySelectionStore } from "@/features/entry";
import { useEditorStore } from "@/features/editor/state";

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
  const initialActiveDocument =
    useEntrySelectionStore.getState().activeDocument;

  return {
    initialActiveDocument,
    suppressPaths: (paths) => {
      useEditorStore.getState().suppressPaths(paths);
    },
    clearInitialUnsaved: (path) => {
      if (initialActiveDocument === path) {
        useEditorStore.getState().clearUnsaved(path);
      }
    },
    reopenInitialDocument: (fromPath, toPath) => {
      if (initialActiveDocument !== fromPath) return;
      useEditorStore.getState().clearUnsaved(fromPath);
      useEntrySelectionStore.getState().openDocument(toPath, spaceId);
    },
    activeDocument: () => useEntrySelectionStore.getState().activeDocument,
    reopenDocumentSnapshot: (activeDocument, fromPath, toPath) => {
      if (activeDocument !== fromPath) return;
      useEditorStore.getState().clearUnsaved(fromPath);
      useEntrySelectionStore.getState().openDocument(toPath, spaceId);
    },
  };
}
