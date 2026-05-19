import { invoke } from "@tauri-apps/api/core";
import type { QueryFilter, QuerySort } from "@/features/collection/query";
import type { Entry } from "@/features/editor/types";

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
  });
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
  const existing = await invoke<Record<string, string[]>>("read_tree_order", {
    space: spacePath,
  }).catch(() => ({}));

  await invoke("save_tree_order", {
    space: spacePath,
    order: {
      ...existing,
      [orderKey || "."]: entries.map(orderNameForEntry),
    },
    projectPath: projectPath ?? null,
  });
}

function orderNameForEntry(entry: Entry) {
  if (entry.path.toLowerCase().endsWith("/readme.md")) {
    const folder = entry.path.replace(/\/readme\.md$/i, "");
    return folder.split("/").at(-1) ?? folder;
  }
  return entry.path.split("/").at(-1) ?? entry.path;
}
