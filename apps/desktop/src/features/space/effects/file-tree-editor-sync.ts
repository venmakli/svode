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
  readonly initialActiveContentPath: string | null;
  suppressPaths: (paths: string[]) => void;
  clearInitialUnsaved: (path: string) => void;
  reopenInitialPage: (fromPath: string, toPath: string) => void;
  activeContentPath: () => string | null;
  reopenPageSnapshot: (
    activeContentPath: string | null,
    fromPath: string,
    toPath: string,
  ) => void;
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
    initialActiveContentPath,
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
    activeContentPath: getActiveContentPath,
    reopenPageSnapshot: (activeContentPath, fromPath, toPath) => {
      if (activeContentPath !== fromPath) return;
      if (getActiveContentSpaceId() !== spaceId) return;
      clearEditorFileUnsaved(spacePath, fromPath);
      openPage(toPath, spaceId);
    },
  };
}
