import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { QueryFilter, QuerySort } from "@/features/collection/query";
import { normalizeEntryPath } from "@/features/collection/lib/utils";
import type { Entry } from "@/features/entry";

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
  const path = normalizeEntryPath(entry.path);
  if (path.toLowerCase().endsWith("/readme.md")) {
    const folder = path.replace(/\/readme\.md$/i, "");
    return folder.split("/").at(-1) ?? folder;
  }
  return path.split("/").at(-1) ?? path;
}
