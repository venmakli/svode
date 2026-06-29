export function editorFileKey(
  scopePath: string | null | undefined,
  path: string,
): string {
  const normalizedPath = normalizeEditorDocumentPath(path);
  const normalizedScope = normalizeEditorScopePath(scopePath);
  return normalizedScope
    ? `${normalizedScope}\0${normalizedPath}`
    : normalizedPath;
}

export function editorFileKeysForClear(
  scopePath: string | null | undefined,
  path: string,
): string[] {
  const key = editorFileKey(scopePath, path);
  const legacyKey = normalizeEditorDocumentPath(path);
  return key === legacyKey ? [key] : [key, legacyKey];
}

function normalizeEditorScopePath(path: string | null | undefined): string {
  return (path ?? "").replaceAll("\\", "/").replace(/\/+$/g, "");
}

function normalizeEditorDocumentPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}
