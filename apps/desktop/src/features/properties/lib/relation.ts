import type { ResolvedRelationEntry } from "../model/types";

export function relationValueForPath(relation: string, filePath: string) {
  const root = normalizeRelationRoot(relation);
  const path = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (root === ".") return path;
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function normalizeRelationRoot(relation: string | null | undefined) {
  const normalized = (relation || ".")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized || ".";
}

export function resolvedRelationPath(entry: ResolvedRelationEntry) {
  return entry.filePath ?? entry.file_path ?? "";
}
