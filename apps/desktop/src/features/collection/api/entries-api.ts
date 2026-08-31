import {
  listEntriesForView as listEntriesForViewDto,
  queryCollectionEntries as queryCollectionEntriesDto,
} from "@/platform/collections/collections-api";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import { normalizePages, type Page } from "@/features/page";
import {
  savePageTreeOrder,
  savePageTreeOrderNames,
} from "@/features/page/page-api";

export function queryCollectionEntries({
  spacePath,
  collectionPath,
  filters,
  sort,
  includeNested,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  filters: QueryFilter[] | null;
  sort: QuerySort[] | null;
  includeNested: boolean;
  projectPath?: string | null;
}) {
  return queryCollectionEntriesDto({
    spacePath,
    collectionPath,
    filters,
    sort,
    includeNested,
    projectPath: projectPath ?? null,
  }).then(normalizePages);
}

export function listEntriesForView({
  spacePath,
  collectionPath,
  viewName,
  includeNested,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  viewName: string;
  includeNested: boolean;
  projectPath?: string | null;
}) {
  return listEntriesForViewDto({
    spacePath,
    collectionPath,
    viewName,
    includeNested,
    projectPath: projectPath ?? null,
  }).then(normalizePages);
}

export async function saveCollectionTreeOrder({
  spacePath,
  orderKey,
  entries,
  projectPath,
}: {
  spacePath: string;
  orderKey: string;
  entries: Page[];
  projectPath?: string | null;
}) {
  await savePageTreeOrder({
    spacePath,
    orderKey,
    pages: entries,
    projectPath,
  });
}

export async function saveCollectionTreeOrderNames({
  spacePath,
  orderKey,
  names,
  projectPath,
}: {
  spacePath: string;
  orderKey: string;
  names: string[];
  projectPath?: string | null;
}) {
  await savePageTreeOrderNames({
    spacePath,
    orderKey,
    names,
    projectPath,
  });
}
