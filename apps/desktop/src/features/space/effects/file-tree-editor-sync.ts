import {
  getActiveContentPath,
  getActiveContentSpaceId,
} from "@/features/artifact";
import { openPage } from "@/features/page/navigation";
import {
  clearEditorFileUnsaved,
  suppressEditorFileEvents,
} from "@/features/editor/file-tree-sync";

export interface FileTreeEditorSync {
  suppressPaths: (paths: string[]) => void;
  clearInitialUnsaved: (path: string) => void;
  reopenInitialPage: (fromPath: string, toPath: string) => void;
  /** Opens the initial Page at the path `relocate` gives it, if any. */
  followInitialPage: (relocate: (path: string) => string | null) => void;
}

export function createFileTreeEditorSync(
  spaceId: string,
  spacePath: string,
): FileTreeEditorSync {
  const initialActiveContentPath = getActiveContentPath();
  const initialActiveContentPathSpaceId = getActiveContentSpaceId();

  const isInitialPage = (path: string) =>
    initialActiveContentPathSpaceId === spaceId && initialActiveContentPath === path;

  return {
    suppressPaths: (paths) => {
      suppressEditorFileEvents(spacePath, paths);
    },
    clearInitialUnsaved: (path) => {
      if (isInitialPage(path)) {
        clearEditorFileUnsaved(spacePath, path);
      }
    },
    reopenInitialPage: (fromPath, toPath) => {
      if (!isInitialPage(fromPath)) return;
      clearEditorFileUnsaved(spacePath, fromPath);
      openPage(toPath, spaceId);
    },
    followInitialPage: (relocate) => {
      // A shown Page that followed with its session has left the path.
      if (
        initialActiveContentPathSpaceId !== spaceId ||
        !initialActiveContentPath ||
        getActiveContentPath() !== initialActiveContentPath
      )
        return;
      const toPath = relocate(initialActiveContentPath);
      if (!toPath) return;
      clearEditorFileUnsaved(spacePath, initialActiveContentPath);
      openPage(toPath, spaceId);
    },
  };
}
