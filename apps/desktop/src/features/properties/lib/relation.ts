import type { Column, ResolvedRelationEntry } from "../model/types";

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
  return entry.filePath ?? "";
}

export function normalizeRelationValues(
  column: Pick<Column, "limit">,
  value: unknown,
) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const values = Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\\/g, "/").replace(/^\/+/, ""))
        .filter(Boolean),
    ),
  );
  return column.limit === "one" ? values.slice(0, 1) : values;
}
