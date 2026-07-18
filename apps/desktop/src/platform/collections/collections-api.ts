import { invokeCommand } from "@/platform/native/invoke";
import type { EntryDto } from "@/platform/entries/entries-api";
import type {
  CollectionSchemaDto,
  ColumnDto,
  PropertyOptionDto,
} from "@/platform/properties/properties-api";

export interface QueryFilterDto {
  field: string;
  op: string;
  value?: unknown;
  values?: unknown[];
}

export interface QuerySortDto {
  field: string;
  desc?: boolean;
}

export type CollectionViewDto = Record<string, unknown>;

export type CollectionColumnInputDto = Omit<
  ColumnDto,
  "time_by_default" | "range_by_default" | "two_way" | "options"
> & {
  options?: PropertyOptionDto[] | null;
  timeByDefault?: boolean | null;
  time_by_default?: boolean | null;
  rangeByDefault?: boolean | null;
  range_by_default?: boolean | null;
  twoWay?: string | null;
  two_way?: string | null;
};

export interface CollectionInfoDto {
  path: string;
  title: string;
  rowCount?: number;
  row_count?: number;
  nested: boolean;
}

export interface TemplateInfoDto {
  slug: string;
  kind: string;
  title: string;
  icon?: string | null;
  isDefault?: boolean;
  is_default?: boolean;
}

export type TemplateKindDto = "leaf" | "folder" | "nested_collection";

export interface ConvertToCollectionResultDto {
  oldPath: string;
  collectionPath: string;
  readmePath: string;
  schemaPath: string;
  entry: EntryDto;
}

interface CollectionPathInput {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}

export function createFolder(input: {
  spacePath: string;
  parentPath?: string | null;
  name: string;
  projectPath?: string | null;
}) {
  return invokeCommand<string>("create_folder", {
    space: input.spacePath,
    parentPath: input.parentPath ?? null,
    name: input.name,
    projectPath: input.projectPath ?? null,
  });
}

export function convertToCollection(input: {
  spacePath: string;
  path: string;
  projectPath?: string | null;
}): Promise<ConvertToCollectionResultDto> {
  return invokeCommand<ConvertToCollectionResultDto>("convert_to_collection", {
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath ?? null,
  });
}

export function getCollectionSchema(input: CollectionPathInput) {
  return invokeCommand<CollectionSchemaDto>("get_collection_schema", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
  });
}

export function addCollectionColumn(
  input: CollectionPathInput & { column: CollectionColumnInputDto },
) {
  return invokeCommand<CollectionSchemaDto>("add_schema_column", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    column: toColumnDto(input.column),
    projectPath: input.projectPath ?? null,
  });
}

export function renameCollectionColumn(
  input: CollectionPathInput & { oldName: string; newName: string },
) {
  return invokeCommand<CollectionSchemaDto>("rename_schema_column", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    oldName: input.oldName,
    newName: input.newName,
    projectPath: input.projectPath ?? null,
  });
}

export function updateCollectionSystemFieldLabel(
  input: CollectionPathInput & { field: string; label: string | null },
) {
  return invokeCommand<CollectionSchemaDto>("update_system_field_label", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    field: input.field,
    label: input.label,
    projectPath: input.projectPath ?? null,
  });
}

export function addCollectionView(
  input: CollectionPathInput & {
    view: CollectionViewDto;
    position?: number | null;
  },
) {
  return invokeCommand<CollectionSchemaDto>("add_view", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    view: input.view,
    position: input.position ?? null,
    projectPath: input.projectPath ?? null,
  });
}

export function updateCollectionView(
  input: CollectionPathInput & {
    viewName: string;
    patch: Record<string, unknown>;
  },
) {
  return invokeCommand<CollectionSchemaDto>("update_view", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    viewName: input.viewName,
    patch: input.patch,
    projectPath: input.projectPath ?? null,
  });
}

export function renameCollectionView(
  input: CollectionPathInput & { oldName: string; newName: string },
) {
  return invokeCommand<CollectionSchemaDto>("rename_view", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    oldName: input.oldName,
    newName: input.newName,
    projectPath: input.projectPath ?? null,
  });
}

export function duplicateCollectionView(
  input: CollectionPathInput & { viewName: string; newName: string },
) {
  return invokeCommand<CollectionSchemaDto>("duplicate_view", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    viewName: input.viewName,
    newName: input.newName,
    projectPath: input.projectPath ?? null,
  });
}

export function deleteCollectionView(
  input: CollectionPathInput & { viewName: string },
) {
  return invokeCommand<CollectionSchemaDto>("delete_view", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    viewName: input.viewName,
    projectPath: input.projectPath ?? null,
  });
}

export function reorderCollectionViews(
  input: CollectionPathInput & { newOrder: string[] },
) {
  return invokeCommand<CollectionSchemaDto>("reorder_views", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    newOrder: input.newOrder,
    projectPath: input.projectPath ?? null,
  });
}

export function queryCollectionEntries(input: {
  spacePath: string;
  collectionPath: string;
  filters: QueryFilterDto[] | null;
  sort: QuerySortDto[] | null;
  includeNested: boolean;
  projectPath?: string | null;
}) {
  return invokeCommand<EntryDto[]>("query_entries", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    filters: input.filters,
    sort: input.sort,
    includeNested: input.includeNested,
    limit: null,
    offset: null,
    projectPath: input.projectPath ?? null,
  });
}

export function listEntriesForView(input: {
  spacePath: string;
  collectionPath: string;
  viewName: string;
  includeNested: boolean;
  projectPath?: string | null;
}) {
  return invokeCommand<EntryDto[]>("list_entries_for_view", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    viewName: input.viewName,
    includeNested: input.includeNested,
    projectPath: input.projectPath ?? null,
  });
}

export function listCollectionInfos(spacePath: string) {
  return invokeCommand<CollectionInfoDto[]>("list_collections", {
    space: spacePath,
  });
}

export function listTemplates(input: CollectionPathInput) {
  return invokeCommand<TemplateInfoDto[]>("list_templates", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
  });
}

export function createTemplate(
  input: CollectionPathInput & { title: string; kind: TemplateKindDto },
) {
  return invokeCommand<string>("create_template", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    title: input.title,
    kind: input.kind,
    projectPath: input.projectPath ?? null,
  });
}

export function deleteTemplate(
  input: CollectionPathInput & { templateSlug: string },
) {
  return invokeCommand<void>("delete_template", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    templateSlug: input.templateSlug,
    projectPath: input.projectPath ?? null,
  });
}

export function duplicateTemplate(
  input: CollectionPathInput & { templateSlug: string },
) {
  return invokeCommand<string>("duplicate_template", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    templateSlug: input.templateSlug,
    projectPath: input.projectPath ?? null,
  });
}

export function instantiateTemplate(
  input: CollectionPathInput & {
    templateSlug: string;
    parentDir: string;
    initialTitle?: string | null;
    forceFolder?: boolean;
    contextualDefaults?: Record<string, unknown> | null;
  },
) {
  return invokeCommand<EntryDto>("instantiate_template", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    templateSlug: input.templateSlug,
    parentDir: input.parentDir,
    initialTitle: input.initialTitle ?? null,
    forceFolder: Boolean(input.forceFolder),
    contextualDefaults: input.contextualDefaults ?? {},
    projectPath: input.projectPath ?? null,
  });
}

export function setDefaultTemplate(
  input: CollectionPathInput & { templateSlug: string | null },
) {
  return invokeCommand<CollectionSchemaDto>("set_default_template", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    templateSlug: input.templateSlug,
    projectPath: input.projectPath ?? null,
  });
}

export function reorderTemplates(
  input: CollectionPathInput & { newOrder: string[] },
) {
  return invokeCommand<CollectionSchemaDto>("reorder_templates", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    newOrder: input.newOrder,
    projectPath: input.projectPath ?? null,
  });
}

function toColumnDto(column: CollectionColumnInputDto): ColumnDto {
  const { timeByDefault, rangeByDefault, twoWay, options, ...rest } = column;
  return {
    ...rest,
    options: options?.map((option) => ({ ...option })) ?? options,
    ...(timeByDefault !== undefined ? { time_by_default: timeByDefault } : {}),
    ...(rangeByDefault !== undefined
      ? { range_by_default: rangeByDefault }
      : {}),
    ...(twoWay !== undefined ? { two_way: twoWay } : {}),
  };
}
