import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import type { Column } from "@/features/properties";
import { queryCollectionEntries } from "./entries-api";
import { addCollectionColumn } from "./schema-api";

export interface CollectionInfo {
  path: string;
  title: string;
  rowCount?: number;
  row_count?: number;
  nested: boolean;
}

export function queryCalendarEntries({
  spacePath,
  collectionPath,
  filters,
  sort,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  filters: QueryFilter[];
  sort: QuerySort[];
  projectPath?: string | null;
}) {
  return queryCollectionEntries({
    spacePath,
    collectionPath,
    filters,
    sort,
    includeNested: false,
    projectPath,
  });
}

export function listCollectionInfos(spacePath: string) {
  return invoke<CollectionInfo[]>("list_collections", {
    space: spacePath,
  });
}

export function addCollectionDateColumn({
  spacePath,
  collectionPath,
  column,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  column: Column;
  projectPath?: string | null;
}) {
  return addCollectionColumn({
    spacePath,
    collectionPath,
    column,
    projectPath,
  });
}
