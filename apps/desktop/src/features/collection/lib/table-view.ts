import type { CollectionView } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type {
  CollectionSchema,
  Column,
  PropertyType,
} from "@/features/properties";
import { PROPERTY_TYPES } from "@/features/properties";
import type { CollectionTableRow } from "../model/table-types";
import {
  entryCollectionPath,
  entryParentDir,
  isFolderEntry,
  reorderVisibleEntries,
} from "./entry-tree";
import { showNestedForView } from "./view-options";

export {
  entryCollectionPath,
  entryParentDir,
  isFolderEntry,
  reorderVisibleEntries,
  showNestedForView,
};

export function normalizeVisibleFields(
  view: CollectionView,
  schema: CollectionSchema,
) {
  const configured = Array.isArray(view.visible_fields)
    ? (view.visible_fields as unknown[]).map(String)
    : ["title", ...schema.columns.map((column) => column.name)];
  const allowed = new Set([
    "title",
    "icon",
    ...schema.columns.map((column) => column.name),
  ]);
  const fields = configured.filter((field) => allowed.has(field));
  return fields.includes("title") ? fields : ["title", ...fields];
}

export function defaultColumnWidth(column?: Column) {
  if (!column) return 260;
  if (column.type === "checkbox") return 72;
  if (column.type === "select" || column.type === "status") return 140;
  if (column.type === "text") return 220;
  if (column.type === "url" || column.type === "email") return 200;
  if (column.type === "phone") return 150;
  return 160;
}

export function minColumnWidth(column?: Column) {
  if (!column) return 200;
  if (column.type === "checkbox") return 60;
  if (column.type === "select" || column.type === "status") return 120;
  if (column.type === "text") return 200;
  return 120;
}

export function flattenRows(
  parents: Entry[],
  entries: Entry[],
  expanded: Set<string>,
  collectionPath: string,
  showNested: boolean,
  nestedSchemas: Map<string, CollectionSchema> = new Map(),
) {
  const result: CollectionTableRow[] = [];
  const append = (
    entry: Entry,
    level: number,
    child: boolean,
    nestedSchema?: CollectionSchema | null,
    nestedCollectionPath?: string | null,
  ) => {
    const ownCollectionPath = entryCollectionPath(entry);
    const ownNestedSchema = nestedSchemas.get(ownCollectionPath);
    result.push({
      entry,
      level,
      child,
      nestedCollection: Boolean(ownNestedSchema),
      nestedSchema,
      nestedCollectionPath,
    });
    if (!showNested || !expanded.has(entry.path)) return;
    const folder = ownCollectionPath;
    const directNestedSchema = ownNestedSchema;
    const childSchema = directNestedSchema ?? nestedSchema;
    const childCollectionPath = directNestedSchema
      ? folder
      : nestedCollectionPath;
    entries
      .filter((candidate) => entryParentDir(candidate.path) === folder)
      .forEach((candidate) =>
        append(candidate, level + 1, true, childSchema, childCollectionPath),
      );
  };
  parents
    .filter((entry) => entryParentDir(entry.path) === collectionPath)
    .forEach((entry) => append(entry, 0, false));
  return result;
}

export function nestedPreviewFields(schema: CollectionSchema) {
  const firstTableView = ((schema.views ?? []) as CollectionView[]).find(
    (view) => view?.type === "table",
  );
  if (firstTableView) return normalizeVisibleFields(firstTableView, schema);
  return ["title", ...schema.columns.slice(0, 4).map((column) => column.name)];
}

export function isExpandable(
  entry: Entry,
  entries: Entry[],
  showNested: boolean,
  nestedCollectionPaths: Set<string> = new Set(),
) {
  if (!showNested) return false;
  const folderEntry = isFolderEntry(entry);
  const nestedCollection = nestedCollectionPaths.has(
    entryCollectionPath(entry),
  );
  if (!folderEntry && !nestedCollection) return false;
  const folder = entryCollectionPath(entry);
  return entries.some((candidate) => entryParentDir(candidate.path) === folder);
}

export function isNestedCollection(
  entry: Entry,
  nestedCollectionPaths: Set<string>,
) {
  return nestedCollectionPaths.has(entryCollectionPath(entry));
}

export function uniqueColumnName(schema: CollectionSchema, baseName: string) {
  const names = new Set(schema.columns.map((column) => column.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

export function propertyTypeLabel(type: PropertyType) {
  return PROPERTY_TYPES.find((item) => item.value === type)?.label ?? type;
}
