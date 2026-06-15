import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { Entry } from "@/features/editor/types";
import type {
  RelationTwoWayDiagnostics,
  ResolvedRelationEntry,
} from "../model/types";

export async function resolveRelationsBatch({
  spacePath,
  projectPath,
  relation,
  values,
}: {
  spacePath: string;
  projectPath?: string | null;
  relation: string;
  values: string[];
}) {
  return invoke<Array<ResolvedRelationEntry | null>>("resolve_relations_batch", {
    space: spacePath,
    relation,
    values,
    projectPath: projectPath ?? null,
  });
}

export async function queryRelationTargets({
  spacePath,
  projectPath,
  relation,
  query,
}: {
  spacePath: string;
  projectPath?: string | null;
  relation: string;
  query: string;
}) {
  const trimmed = query.trim();
  const filters = trimmed
    ? [{ field: "title", op: "contains", value: trimmed }]
    : null;
  const entries = await invoke<Entry[]>("query_entries", {
    space: spacePath,
    collectionPath: relation,
    filters,
    sort: null,
    includeNested: true,
    limit: 50,
    offset: null,
    projectPath: projectPath ?? null,
  });
  if (!trimmed) return entries;

  const normalized = trimmed.toLowerCase();
  const matchingEntries = entries.filter(
    (entry) =>
      entry.meta.title.toLowerCase().includes(normalized) ||
      relationValueForPath(relation, entry.path).toLowerCase().includes(normalized),
  );
  if (matchingEntries.length > 0) return matchingEntries;

  const fallback = await invoke<Entry[]>("query_entries", {
    space: spacePath,
    collectionPath: relation,
    filters: null,
    sort: null,
    includeNested: true,
    limit: 200,
    offset: null,
    projectPath: projectPath ?? null,
  });
  return fallback
    .filter(
      (entry) =>
        entry.meta.title.toLowerCase().includes(normalized) ||
        relationValueForPath(relation, entry.path).toLowerCase().includes(normalized),
    )
    .slice(0, 50);
}

export async function diagnoseTwoWayRelation({
  spacePath,
  collectionPath,
  column,
}: {
  spacePath: string;
  collectionPath: string;
  column: string;
}) {
  return invoke<RelationTwoWayDiagnostics>("diagnose_two_way_relation", {
    space: spacePath,
    collectionPath,
    column,
  });
}

export async function repairTwoWayRelation({
  spacePath,
  projectPath,
  collectionPath,
  column,
  strategy,
  reverseColumn,
}: {
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  column: string;
  strategy:
    | "from_this_side"
    | "from_related_side"
    | "choose_reverse_column"
    | "create_reverse_column"
    | "detach_two_way";
  reverseColumn?: string | null;
}) {
  return invoke<void>("repair_two_way_relation", {
    space: spacePath,
    collectionPath,
    column,
    strategy,
    reverseColumn: reverseColumn ?? null,
    projectPath: projectPath ?? null,
  });
}

export function relationValueForPath(relation: string, filePath: string) {
  const root = normalizeRelationRoot(relation);
  const path = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (root === ".") return path;
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function normalizeRelationRoot(relation: string | null | undefined) {
  const normalized = (relation || ".").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized || ".";
}

export function resolvedRelationPath(entry: ResolvedRelationEntry) {
  return entry.filePath ?? entry.file_path ?? "";
}
