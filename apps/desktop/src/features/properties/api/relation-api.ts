import * as propertiesPlatform from "@/platform/properties/properties-api";
import type {
  CompatibleReverseChoiceDto,
  RelationDriftRowDto,
  RelationDriftSummaryDto,
  RelationTargetEntryDto,
  RelationTwoWayDiagnosticsDto,
  ResolvedRelationEntryDto,
} from "@/platform/properties/properties-api";
import { relationValueForPath } from "../lib/relation";
import type {
  CompatibleReverseChoice,
  RelationDriftRow,
  RelationDriftSummary,
  RelationRepairStrategy,
  RelationTarget,
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
  const entries = await propertiesPlatform.resolveRelationsBatch({
    spacePath,
    projectPath,
    relation,
    values,
  });
  return entries.map((entry) => (entry ? toResolvedRelationEntry(entry) : null));
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
  const entries = await propertiesPlatform.queryRelationTargetEntries({
    spacePath,
    projectPath,
    relation,
    titleQuery: trimmed || null,
    limit: 50,
  });
  const targets = entries.map(toRelationTarget);
  if (!trimmed) return targets;

  const normalized = trimmed.toLowerCase();
  const matchingTargets = targets.filter(
    (target) =>
      target.title.toLowerCase().includes(normalized) ||
      relationValueForPath(relation, target.path)
        .toLowerCase()
        .includes(normalized),
  );
  if (matchingTargets.length > 0) return matchingTargets;

  const fallback = await propertiesPlatform.queryRelationTargetEntries({
    spacePath,
    projectPath,
    relation,
    titleQuery: null,
    limit: 200,
  });
  return fallback
    .map(toRelationTarget)
    .filter(
      (target) =>
        target.title.toLowerCase().includes(normalized) ||
        relationValueForPath(relation, target.path)
          .toLowerCase()
          .includes(normalized),
    )
    .slice(0, 50);
}

export async function diagnoseTwoWayRelation({
  spacePath,
  projectPath,
  collectionPath,
  column,
}: {
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  column: string;
}) {
  return toRelationTwoWayDiagnostics(
    await propertiesPlatform.diagnoseTwoWayRelation({
      spacePath,
      projectPath,
      collectionPath,
      column,
    }),
  );
}

export function repairTwoWayRelation({
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
  strategy: RelationRepairStrategy;
  reverseColumn?: string | null;
}) {
  return propertiesPlatform.repairTwoWayRelation({
    spacePath,
    projectPath,
    collectionPath,
    column,
    strategy,
    reverseColumn,
  });
}

function toRelationTarget(entry: RelationTargetEntryDto): RelationTarget {
  return {
    path: entry.path,
    title: entry.meta?.title || entry.path,
    icon: entry.meta?.icon ?? null,
  };
}

function toResolvedRelationEntry(
  entry: ResolvedRelationEntryDto,
): ResolvedRelationEntry {
  return {
    title: entry.title,
    icon: entry.icon ?? null,
    filePath: entry.filePath ?? entry.file_path ?? "",
    collectionRootPath:
      entry.collectionRootPath ?? entry.collection_root_path ?? null,
  };
}

function toRelationTwoWayDiagnostics(
  diagnostics: RelationTwoWayDiagnosticsDto,
): RelationTwoWayDiagnostics {
  return {
    collectionPath:
      diagnostics.collectionPath ?? diagnostics.collection_path ?? "",
    column: diagnostics.column,
    relation: diagnostics.relation ?? null,
    reverseColumn:
      diagnostics.reverseColumn ?? diagnostics.reverse_column ?? null,
    schemaStatus:
      diagnostics.schemaStatus ??
      diagnostics.schema_status ??
      "not_two_way",
    schemaMessage:
      diagnostics.schemaMessage ?? diagnostics.schema_message ?? null,
    compatibleReverseChoices: (
      diagnostics.compatibleReverseChoices ??
      diagnostics.compatible_reverse_choices ??
      []
    ).map(toCompatibleReverseChoice),
    drift: toRelationDriftSummary(diagnostics.drift),
  };
}

function toCompatibleReverseChoice(
  choice: CompatibleReverseChoiceDto,
): CompatibleReverseChoice {
  return {
    name: choice.name,
    twoWay: choice.twoWay ?? choice.two_way ?? null,
  };
}

function toRelationDriftSummary(
  drift: RelationDriftSummaryDto,
): RelationDriftSummary {
  return {
    missingReverseCount:
      drift.missingReverseCount ?? drift.missing_reverse_count ?? 0,
    missingSourceCount:
      drift.missingSourceCount ?? drift.missing_source_count ?? 0,
    rows: drift.rows.map(toRelationDriftRow),
  };
}

function toRelationDriftRow(row: RelationDriftRowDto): RelationDriftRow {
  return {
    kind: row.kind,
    sourceFilePath: row.sourceFilePath ?? row.source_file_path ?? "",
    targetFilePath: row.targetFilePath ?? row.target_file_path ?? "",
    sourceValue: row.sourceValue ?? row.source_value ?? "",
    targetValue: row.targetValue ?? row.target_value ?? "",
  };
}
