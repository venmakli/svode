import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { QueryFilter, QuerySort } from "@/features/collection/query";
import { entriesFromDto, type EntryDto } from "@/features/entry/entry-api";
import type { CollectionSchema, Column } from "@/features/properties";

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
  return invoke<EntryDto[]>("query_entries", {
    space: spacePath,
    collectionPath,
    filters,
    sort,
    includeNested: false,
    limit: null,
    offset: null,
    projectPath: projectPath ?? null,
  }).then(entriesFromDto);
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
  return invoke<CollectionSchema>("add_schema_column", {
    space: spacePath,
    collectionPath,
    column,
    projectPath: projectPath ?? null,
  });
}
