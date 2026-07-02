import type {
  Column,
  RelationContext,
  RelationScope,
  ResolvedRelationEntry,
} from "../model/types";

export interface RelationSpaceLookup {
  activeRootPath?: string | null;
  spaces: Array<{ id: string; path: string }>;
}

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

export function relationScopeKey(scope: RelationScope | null | undefined) {
  if (!scope) return "current";
  if (scope === "root") return "root";
  return `space:${scope.id}`;
}

export function relationScopesEqual(
  left: RelationScope | null | undefined,
  right: RelationScope | null | undefined,
) {
  return relationScopeKey(left) === relationScopeKey(right);
}

export function relationTargetSpacePath(
  context: Pick<RelationContext, "projectPath" | "spacePath"> | undefined,
  scope: RelationScope | null | undefined,
  lookup: RelationSpaceLookup,
) {
  if (!context?.spacePath) return null;
  if (!scope) return context.spacePath;
  if (scope === "root") {
    return context.projectPath || lookup.activeRootPath || null;
  }
  return lookup.spaces.find((space) => space.id === scope.id)?.path ?? null;
}

export function relationTargetSpaceId(
  currentSpaceId: string | null | undefined,
  projectSpaceId: string | null | undefined,
  scope: RelationScope | null | undefined,
) {
  if (!scope) return currentSpaceId ?? null;
  if (scope === "root") return projectSpaceId ?? null;
  return scope.id;
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
