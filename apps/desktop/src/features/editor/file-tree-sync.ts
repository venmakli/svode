import { useEditorStore } from "./model";

export function useEditorFilePendingWrite(path: string): boolean {
  return useEditorStore((state) => !!state.unsavedChanges[path]);
}

export function clearEditorFileUnsaved(path: string): void {
  useEditorStore.getState().clearUnsaved(path);
}

export function markEditorFilesStale(paths: string[]): void {
  const editor = useEditorStore.getState();
  for (const path of paths) {
    editor.markStale(path);
  }
}

export function requestEditorFileRename(
  path: string,
  title: string,
  newPath: string | null,
): void {
  useEditorStore.getState().requestRename(path, title, newPath);
}

export function suppressEditorFileEvents(paths: string[]): void {
  useEditorStore.getState().suppressPaths(paths);
}
