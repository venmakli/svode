import type { CollectionView } from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import type { CollectionSchema, Column } from "@/features/properties";
import type { CollectionTableRow } from "../model/table-types";
import {
  itemCollectionPath,
  itemParentDir,
  isFolderItem,
  reorderVisibleItems,
} from "./item-tree";
import { showNestedForView } from "./view-options";

export {
  itemCollectionPath,
  itemParentDir,
  isFolderItem,
  reorderVisibleItems,
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
  if (column.type === "boolean") return 72;
  if (column.type === "select" || column.type === "status") return 140;
  if (column.type === "text") return 220;
  if (column.type === "url" || column.type === "email") return 200;
  if (column.type === "phone") return 150;
  return 160;
}

export function minColumnWidth(column?: Column) {
  if (!column) return 200;
  if (column.type === "boolean") return 60;
  if (column.type === "select" || column.type === "status") return 120;
  if (column.type === "text") return 200;
  return 120;
}

export function flattenRows(
  parents: Page[],
  items: Page[],
  expanded: Set<string>,
  collectionPath: string,
  showNested: boolean,
  nestedSchemas: Map<string, CollectionSchema> = new Map(),
) {
  const result: CollectionTableRow[] = [];
  const append = (
    item: Page,
    level: number,
    child: boolean,
    nestedSchema?: CollectionSchema | null,
    nestedCollectionPath?: string | null,
  ) => {
    const ownCollectionPath = itemCollectionPath(item);
    const ownNestedSchema = nestedSchemas.get(ownCollectionPath);
    result.push({
      item,
      level,
      child,
      nestedCollection: Boolean(ownNestedSchema),
      nestedSchema,
      nestedCollectionPath,
    });
    if (!showNested || !expanded.has(item.path)) return;
    const folder = ownCollectionPath;
    const directNestedSchema = ownNestedSchema;
    const childSchema = directNestedSchema ?? nestedSchema;
    const childCollectionPath = directNestedSchema
      ? folder
      : nestedCollectionPath;
    items
      .filter((candidate) => itemParentDir(candidate.path) === folder)
      .forEach((candidate) =>
        append(candidate, level + 1, true, childSchema, childCollectionPath),
      );
  };
  parents
    .filter((item) => itemParentDir(item.path) === collectionPath)
    .forEach((item) => append(item, 0, false));
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
  item: Page,
  items: Page[],
  showNested: boolean,
  nestedCollectionPaths: Set<string> = new Set(),
) {
  if (!showNested) return false;
  const folderItem = isFolderItem(item);
  const nestedCollection = nestedCollectionPaths.has(itemCollectionPath(item));
  if (!folderItem && !nestedCollection) return false;
  const folder = itemCollectionPath(item);
  return items.some((candidate) => itemParentDir(candidate.path) === folder);
}

export function isNestedCollection(
  item: Page,
  nestedCollectionPaths: Set<string>,
) {
  return nestedCollectionPaths.has(itemCollectionPath(item));
}
