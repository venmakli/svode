import type { CollectionView } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type { CollectionSchema, Column } from "@/features/properties";
import type { ListRowModel } from "../model/list-types";
import {
  entryCollectionPath,
  entryParentDir,
  isFolderEntry,
  replaceSiblings,
  siblingEntries,
} from "./entry-tree";

const LIST_CANONICAL_FIELDS = new Set([
  "title",
  "icon",
  "description",
  "cover",
]);

const SYSTEM_META_COLUMNS: Record<string, Column> = {
  created: { name: "created", type: "date", display: "medium" },
  updated: { name: "updated", type: "date", display: "medium" },
};

export function listDensity(view: CollectionView): "compact" | "comfortable" {
  return view.density === "compact" ? "compact" : "comfortable";
}

export function normalizeListCardFields(
  view: CollectionView,
  schema: CollectionSchema,
) {
  const configured = Array.isArray(view.card_fields)
    ? (view.card_fields as unknown[]).map(String)
    : [
        "icon",
        "title",
        "description",
        ...schema.columns.slice(0, 4).map((column) => column.name),
      ];
  const allowed = new Set([
    "title",
    "icon",
    "description",
    "created",
    "updated",
    ...schema.columns.map((column) => column.name),
  ]);
  const fields = configured.filter((field) => allowed.has(field));
  return fields.includes("title") ? fields : ["title", ...fields];
}

export function listMetaColumns(fields: string[], schema: CollectionSchema) {
  return fields
    .filter((field) => !LIST_CANONICAL_FIELDS.has(field))
    .map(
      (field) =>
        SYSTEM_META_COLUMNS[field] ??
        schema.columns.find((column) => column.name === field),
    )
    .filter((column): column is Column => Boolean(column));
}

export function flattenListRows({
  parents,
  entries,
  expanded,
  collectionPath,
  nestedCollectionPaths,
}: {
  parents: Entry[];
  entries: Entry[];
  expanded: Set<string>;
  collectionPath: string;
  nestedCollectionPaths: Set<string>;
}) {
  const rows: ListRowModel[] = [];
  const append = (entry: Entry, level: number) => {
    const folder = entryCollectionPath(entry);
    const nestedCollection = nestedCollectionPaths.has(folder);
    const children = entries.filter(
      (candidate) => entryParentDir(candidate.path) === folder,
    );
    const expandable =
      isFolderEntry(entry) && !nestedCollection && children.length > 0;
    const isExpanded = expanded.has(entry.path);
    rows.push({
      entry,
      level,
      expandable,
      expanded: isExpanded,
      nestedCollection,
    });
    if (!expandable || !isExpanded) return;
    children.forEach((child) => append(child, level + 1));
  };

  parents
    .filter((entry) => entryParentDir(entry.path) === collectionPath)
    .forEach((entry) => append(entry, 0));

  return rows;
}

export { isFolderEntry, replaceSiblings, siblingEntries };
