import { invokeCommand } from "@/platform/native/invoke";

export type PropertyTypeDto =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "unique_id"
  | "actor"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "relation";

export type ColorNameDto =
  | "neutral"
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "brown";

export type StatusGroupDto = "todo" | "in_progress" | "done";
export type RelationRepairStrategyDto =
  | "from_this_side"
  | "from_related_side"
  | "choose_reverse_column"
  | "create_reverse_column"
  | "detach_two_way";

export interface PropertyOptionDto {
  name: string;
  color?: ColorNameDto | null;
  icon?: string | null;
  group?: StatusGroupDto | null;
}

export type RelationScopeDto = "root" | { type: "space"; id: string };

export interface ColumnDto {
  name: string;
  type?: PropertyTypeDto;
  type_?: PropertyTypeDto;
  default?: unknown;
  options?: PropertyOptionDto[] | null;
  display?: string | null;
  min?: number | null;
  max?: number | null;
  color?: ColorNameDto | null;
  timeByDefault?: boolean | null;
  time_by_default?: boolean | null;
  rangeByDefault?: boolean | null;
  range_by_default?: boolean | null;
  relation?: string | null;
  relationScope?: RelationScopeDto | null;
  relation_scope?: RelationScopeDto | null;
  limit?: "one" | null;
  twoWay?: string | null;
  two_way?: string | null;
  prefix?: string | null;
  next?: number | null;
  multiple?: boolean | null;
  sensitivity?: "pii" | "none" | null;
}

export interface CollectionSchemaDto {
  systemFields?: {
    title?: { label?: string | null } | null;
  } | null;
  system_fields?: {
    title?: { label?: string | null } | null;
  } | null;
  document?: { label?: string | null } | null;
  templates?: { default?: string | null; order?: string[] | null } | null;
  columns: ColumnDto[];
  views?: unknown[];
}

export interface SchemaMutationWarningDto {
  code: string;
  field: string;
  count: number;
}

export interface ChangeSchemaTypeResultDto {
  schema: CollectionSchemaDto;
  warnings: SchemaMutationWarningDto[];
}

export interface EntrySchemaResultDto {
  schema: CollectionSchemaDto;
  collectionRootPath?: string;
  collection_root_path?: string;
}

export interface ActorCandidateDto {
  email: string;
  name: string;
  lastCommitAt?: number | null;
  last_commit_at?: number | null;
  commitCount?: number;
  commit_count?: number;
  isMe?: boolean;
  is_me?: boolean;
}

export interface AssignedEntryDto {
  meta?: {
    extra?: Record<string, unknown> | null;
  } | null;
}

export interface CollectionOptionDto {
  path: string;
  title: string;
}

export interface RelationTargetEntryDto {
  path: string;
  meta?: {
    title?: string | null;
    icon?: string | null;
  } | null;
}

export interface ResolvedRelationEntryDto {
  title: string;
  icon?: string | null;
  filePath?: string;
  file_path?: string;
  collectionRootPath?: string | null;
  collection_root_path?: string | null;
}

export type RelationTwoWaySchemaStatusDto =
  | "ok"
  | "not_two_way"
  | "missing_reverse"
  | "incompatible_reverse";

export type RelationDriftKindDto = "missing_reverse" | "missing_source";

export interface CompatibleReverseChoiceDto {
  name: string;
  twoWay?: string | null;
  two_way?: string | null;
}

export interface RelationDriftRowDto {
  kind: RelationDriftKindDto;
  sourceFilePath?: string;
  source_file_path?: string;
  targetFilePath?: string;
  target_file_path?: string;
  sourceValue?: string;
  source_value?: string;
  targetValue?: string;
  target_value?: string;
}

export interface RelationDriftSummaryDto {
  missingReverseCount?: number;
  missing_reverse_count?: number;
  missingSourceCount?: number;
  missing_source_count?: number;
  rows: RelationDriftRowDto[];
}

export interface RelationTwoWayDiagnosticsDto {
  collectionPath?: string;
  collection_path?: string;
  column: string;
  relation?: string | null;
  reverseColumn?: string | null;
  reverse_column?: string | null;
  schemaStatus?: RelationTwoWaySchemaStatusDto;
  schema_status?: RelationTwoWaySchemaStatusDto;
  schemaMessage?: string | null;
  schema_message?: string | null;
  compatibleReverseChoices?: CompatibleReverseChoiceDto[];
  compatible_reverse_choices?: CompatibleReverseChoiceDto[];
  drift: RelationDriftSummaryDto;
}

export interface SchemaMutationInputDto {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}

export function listActors(spacePath: string, allTime = false) {
  return invokeCommand<ActorCandidateDto[]>("list_actors", {
    spacePath,
    allTime,
  });
}

export function getEntrySchema(input: { spacePath: string; filePath: string }) {
  return invokeCommand<EntrySchemaResultDto | null>("get_entry_schema", {
    space: input.spacePath,
    filePath: input.filePath,
  });
}

export function getCollectionSchema(input: SchemaMutationInputDto) {
  return invokeSchemaMutation<CollectionSchemaDto>(
    "get_collection_schema",
    input,
    {},
  );
}

export function listCollections(spacePath: string) {
  return invokeCommand<CollectionOptionDto[]>("list_collections", {
    space: spacePath,
  });
}

export function assignUniqueId(input: {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}) {
  return invokeCommand<AssignedEntryDto>("assign_unique_id", {
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
}

export function normalizeUniqueIdCounter(input: SchemaMutationInputDto) {
  return invokeSchemaMutation<CollectionSchemaDto>(
    "normalize_unique_id_counter",
    input,
    {},
  );
}

export function changeSchemaType(input: {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  columnName: string;
  newType: PropertyTypeDto;
  conversionStrategy?: Record<string, unknown>;
}) {
  return invokeCommand<ChangeSchemaTypeResultDto>("change_schema_type", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    projectPath: input.projectPath ?? null,
    columnName: input.columnName,
    newType: input.newType,
    conversionStrategy: input.conversionStrategy,
  });
}

export function clearFieldValues(
  input: SchemaMutationInputDto & { field: string },
) {
  return invokeSchemaMutation("clear_field_values", input, {
    field: input.field,
  });
}

export function clearOptionValues(
  input: SchemaMutationInputDto & {
    columnName: string;
    optionNames: string[];
  },
) {
  return invokeSchemaMutation("clear_option_values", input, {
    columnName: input.columnName,
    optionNames: input.optionNames,
  });
}

export function promoteOrphan(
  input: SchemaMutationInputDto & {
    filePath: string;
    field: string;
  },
) {
  return invokeSchemaMutation("promote_orphan", input, {
    filePath: input.filePath,
    field: input.field,
  });
}

export function addSchemaColumn(
  input: SchemaMutationInputDto & { column: ColumnDto },
) {
  return invokeSchemaMutation("add_schema_column", input, {
    column: input.column,
  });
}

export function updateSchemaColumn(
  input: SchemaMutationInputDto & {
    columnName: string;
    patch: Record<string, unknown>;
  },
) {
  return invokeSchemaMutation<CollectionSchemaDto>(
    "update_schema_column",
    input,
    {
      columnName: input.columnName,
      patch: input.patch,
    },
  );
}

export function renameSchemaColumn(
  input: SchemaMutationInputDto & {
    oldName: string;
    newName: string;
  },
) {
  return invokeSchemaMutation("rename_schema_column", input, {
    oldName: input.oldName,
    newName: input.newName,
  });
}

export function deleteSchemaColumn(
  input: SchemaMutationInputDto & {
    columnName: string;
    deleteValues: boolean;
  },
) {
  return invokeSchemaMutation<CollectionSchemaDto>(
    "delete_schema_column",
    input,
    {
      columnName: input.columnName,
      deleteValues: input.deleteValues,
    },
  );
}

export function addOption(
  input: SchemaMutationInputDto & {
    columnName: string;
    option: PropertyOptionDto;
  },
) {
  return invokeSchemaMutation<CollectionSchemaDto>("add_option", input, {
    columnName: input.columnName,
    option: input.option,
  });
}

export function updateOption(
  input: SchemaMutationInputDto & {
    columnName: string;
    optionName: string;
    option?: PropertyOptionDto | null;
    patch: Record<string, unknown>;
  },
) {
  return invokeSchemaMutation<CollectionSchemaDto>("update_option", input, {
    columnName: input.columnName,
    optionName: input.optionName,
    option: input.option ?? null,
    patch: input.patch,
  });
}

export function renameOption(
  input: SchemaMutationInputDto & {
    columnName: string;
    oldOptionName: string;
    newOptionName: string;
  },
) {
  return invokeSchemaMutation<CollectionSchemaDto>("rename_option", input, {
    columnName: input.columnName,
    oldOptionName: input.oldOptionName,
    newOptionName: input.newOptionName,
  });
}

export function deleteOption(
  input: SchemaMutationInputDto & {
    columnName: string;
    optionName: string;
    deleteValues: boolean;
  },
) {
  return invokeSchemaMutation<CollectionSchemaDto>("delete_option", input, {
    columnName: input.columnName,
    optionName: input.optionName,
    deleteValues: input.deleteValues,
  });
}

export function resolveRelationsBatch(input: {
  spacePath: string;
  projectPath?: string | null;
  relation: string;
  values: string[];
}) {
  return invokeCommand<Array<ResolvedRelationEntryDto | null>>(
    "resolve_relations_batch",
    {
      space: input.spacePath,
      relation: input.relation,
      values: input.values,
      projectPath: input.projectPath ?? null,
    },
  );
}

export function queryRelationTargetEntries(input: {
  spacePath: string;
  projectPath?: string | null;
  relation: string;
  titleQuery?: string | null;
  limit: number;
}) {
  const filters = input.titleQuery
    ? [{ field: "title", op: "contains", value: input.titleQuery }]
    : null;
  return invokeCommand<RelationTargetEntryDto[]>("query_entries", {
    space: input.spacePath,
    collectionPath: input.relation,
    filters,
    sort: null,
    includeNested: true,
    limit: input.limit,
    offset: null,
    projectPath: input.projectPath ?? null,
  });
}

export function diagnoseTwoWayRelation(input: {
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  column: string;
}) {
  return invokeCommand<RelationTwoWayDiagnosticsDto>(
    "diagnose_two_way_relation",
    {
      space: input.spacePath,
      collectionPath: input.collectionPath,
      column: input.column,
      projectPath: input.projectPath ?? null,
    },
  );
}

export function repairTwoWayRelation(input: {
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  column: string;
  strategy: RelationRepairStrategyDto;
  reverseColumn?: string | null;
}) {
  return invokeCommand<void>("repair_two_way_relation", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    column: input.column,
    strategy: input.strategy,
    reverseColumn: input.reverseColumn ?? null,
    projectPath: input.projectPath ?? null,
  });
}

function invokeSchemaMutation<T = unknown>(
  command: string,
  input: SchemaMutationInputDto,
  args: Record<string, unknown>,
) {
  return invokeCommand<T>(command, {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    projectPath: input.projectPath ?? null,
    ...args,
  });
}
