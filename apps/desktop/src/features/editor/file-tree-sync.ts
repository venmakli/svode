import { useEditorStore } from "./model";

export function useEditorFilePendingWrite(
  scopePath: string | null | undefined,
  path: string,
): boolean {
  return useEditorStore((state) => state.hasUnsaved(scopePath, path));
}

export function clearEditorFileUnsaved(
  scopePath: string | null | undefined,
  path: string,
): void {
  useEditorStore.getState().clearUnsaved(scopePath, path);
}

export function markEditorFilesStale(
  scopePath: string | null | undefined,
  paths: string[],
): void {
  const editor = useEditorStore.getState();
  for (const path of paths) {
    editor.markStale(scopePath, path);
  }
}

export function clearCommittedReviewMarkers(
  scopePath: string | null | undefined,
  paths: string[],
): void {
  if (paths.length === 0) return;
  const editor = useEditorStore.getState();
  for (const path of paths) {
    editor.clearAiModified(scopePath, path);
  }
}

export function requestEditorFileRename(
  scopePath: string | null | undefined,
  path: string,
  title: string,
  newPath: string | null,
): void {
  useEditorStore.getState().requestRename(scopePath, path, title, newPath);
}

export function suppressEditorFileEvents(
  scopePath: string | null | undefined,
  paths: string[],
): void {
  useEditorStore.getState().suppressPaths(scopePath, paths);
}
