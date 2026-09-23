import type { Descendant } from "platejs";

const DOCUMENT_CACHE_SEPARATOR = "\0";
const documentValueCache = new Map<string, Descendant[]>();
const documentBaselines = new Map<string, DocumentSourceBaseline>();

/**
 * The source a document's editor value was loaded from or last written as.
 * It outlives a dropped cached value: an open editor keeps writing from it,
 * and a reopen without a cached value reads a new one.
 */
export interface DocumentSourceBaseline {
  version: string;
  body: string;
}

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

export function getDocumentBaseline(
  key: string,
): DocumentSourceBaseline | null {
  return documentBaselines.get(key) ?? null;
}

export function setDocumentBaseline(
  key: string,
  baseline: DocumentSourceBaseline,
): void {
  documentBaselines.set(key, baseline);
}

export function deleteDocumentBaseline(key: string): void {
  documentBaselines.delete(key);
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
