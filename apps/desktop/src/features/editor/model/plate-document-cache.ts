import type { Descendant } from "platejs";

const DOCUMENT_CACHE_SEPARATOR = "\0";
const documentValueCache = new Map<string, Descendant[]>();

export function getDocumentCacheKey(spacePath: string, path: string): string {
  return `${spacePath}${DOCUMENT_CACHE_SEPARATOR}${path}`;
}

export function getCachedDocumentValue(
  spacePath: string,
  path: string,
): Descendant[] | null {
  return documentValueCache.get(getDocumentCacheKey(spacePath, path)) ?? null;
}

export function setCachedDocumentValue(
  spacePath: string,
  path: string,
  value: Descendant[],
): void {
  documentValueCache.set(getDocumentCacheKey(spacePath, path), value);
}

export function setCachedDocumentValueByKey(
  key: string,
  value: Descendant[],
): void {
  documentValueCache.set(key, value);
}

export function deleteCachedDocumentValue(
  path: string,
  spacePath?: string | null,
): void {
  if (spacePath) {
    documentValueCache.delete(getDocumentCacheKey(spacePath, path));
    return;
  }

  const pathSuffix = `${DOCUMENT_CACHE_SEPARATOR}${path}`;
  for (const key of documentValueCache.keys()) {
    if (key.endsWith(pathSuffix)) documentValueCache.delete(key);
  }
}
