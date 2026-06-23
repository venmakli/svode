import type { StoredViewQueryState } from "../model/types";

export function readStoredViewQuery(key: string): StoredViewQueryState | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredViewQueryState>;
    if (!parsed.baseViewHash || !parsed.updatedAt) return null;
    return parsed as StoredViewQueryState;
  } catch {
    return null;
  }
}

export function writeStoredViewQuery(
  key: string,
  value: StoredViewQueryState | null,
) {
  if (!value || !hasStoredQueryChanges(value)) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
}

function hasStoredQueryChanges(value: StoredViewQueryState) {
  return (
    Object.prototype.hasOwnProperty.call(value, "filter") ||
    Object.prototype.hasOwnProperty.call(value, "sort") ||
    Object.prototype.hasOwnProperty.call(value, "groupBy")
  );
}
