import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { QueryFilter, QuerySort } from "@/features/collection/query";
import { normalizeEntries, type Entry } from "@/features/entry";
import {
  saveEntryTreeOrder,
  saveEntryTreeOrderNames,
} from "@/features/entry/entry-api";

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
  return invoke<Entry[]>("query_entries", {
    space: spacePath,
    collectionPath,
    filters,
    sort,
    includeNested,
    limit: null,
    offset: null,
    projectPath: projectPath ?? null,
  }).then(normalizeEntries);
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
  return invoke<Entry[]>("list_entries_for_view", {
    space: spacePath,
    collectionPath,
    viewName,
    includeNested,
    projectPath: projectPath ?? null,
  }).then(normalizeEntries);
}

export async function saveCollectionTreeOrder({
  spacePath,
  orderKey,
  entries,
  projectPath,
}: {
  spacePath: string;
  orderKey: string;
  entries: Entry[];
  projectPath?: string | null;
}) {
  await saveEntryTreeOrder({
    spacePath,
    orderKey,
    entries,
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
  await saveEntryTreeOrderNames({
    spacePath,
    orderKey,
    names,
    projectPath,
  });
}
