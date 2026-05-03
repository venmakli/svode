import type { SearchItem } from "./types";

// Dedup key mirrors the backend's `(spaceId, path)` identity (06-search §spec):
// `spaceId === null` is the root pool, distinct from any child-space pool that
// happens to share the same relative path.
export function dedupKey(item: SearchItem): string {
  return `${item.spaceId ?? ""}::${item.path}`;
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx) + "/";
}

export function joinAbs(spacePath: string, rel: string): string {
  if (!rel) return spacePath;
  if (spacePath.endsWith("/")) return spacePath + rel;
  return spacePath + "/" + rel;
}
