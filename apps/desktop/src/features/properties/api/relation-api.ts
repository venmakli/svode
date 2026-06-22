import { invokeCommand as invoke } from "@/platform/native/invoke";
import type {
  RelationTarget,
  RelationTwoWayDiagnostics,
  ResolvedRelationEntry,
} from "../model/types";
import { relationValueForPath } from "../lib/relation";

interface RelationTargetEntryDto {
  path: string;
  meta?: {
    title?: string | null;
    icon?: string | null;
  } | null;
}

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
  const entries = await invoke<RelationTargetEntryDto[]>("query_entries", {
    space: spacePath,
    collectionPath: relation,
    filters,
    sort: null,
    includeNested: true,
    limit: 50,
    offset: null,
    projectPath: projectPath ?? null,
  });
  const targets = entries.map(toRelationTarget);
  if (!trimmed) return targets;

  const normalized = trimmed.toLowerCase();
  const matchingTargets = targets.filter(
    (target) =>
      target.title.toLowerCase().includes(normalized) ||
      relationValueForPath(relation, target.path).toLowerCase().includes(normalized),
  );
  if (matchingTargets.length > 0) return matchingTargets;

  const fallback = await invoke<RelationTargetEntryDto[]>("query_entries", {
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
    .map(toRelationTarget)
    .filter(
      (target) =>
        target.title.toLowerCase().includes(normalized) ||
        relationValueForPath(relation, target.path).toLowerCase().includes(normalized),
    )
    .slice(0, 50);
}

function toRelationTarget(entry: RelationTargetEntryDto): RelationTarget {
  return {
    path: entry.path,
    title: entry.meta?.title || entry.path,
    icon: entry.meta?.icon ?? null,
  };
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
