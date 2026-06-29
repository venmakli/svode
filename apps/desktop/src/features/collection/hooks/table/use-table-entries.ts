import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStableViewQueryArgs } from "@/features/collection/query/hooks";
import {
  type CollectionView,
  type QueryFilter,
  type QuerySort,
} from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import {
  getCollectionSchema,
  listCollectionInfos,
  queryCollectionEntries,
} from "../../api";
import { entryCollectionPath } from "../../lib/entry-tree";
import {
  collectionEntriesTargetKey,
  mergeStableEntriesByPath,
  sameStringSet,
} from "../../lib/entry-refresh";
import { showNestedForView } from "../../lib/view-options";
import * as m from "@/paraglide/messages.js";

export function useTableEntries({
  collectionPath,
  filters,
  includeNested,
  projectPath,
  refreshToken,
  sort,
  spacePath,
}: {
  collectionPath: string;
  filters: QueryFilter[];
  includeNested: boolean;
  projectPath?: string | null;
  refreshToken: number;
  sort: QuerySort[];
  spacePath: string;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [nestedSchemas, setNestedSchemas] = useState<
    Map<string, CollectionSchema>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const targetKey = collectionEntriesTargetKey({
    collectionPath,
    projectPath,
    spacePath,
  });
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const loadedTargetRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const queryArgs = useStableViewQueryArgs(filters, sort);

  const loadEntries = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    const requestTarget = targetKey;
    const initialLoad = loadedTargetRef.current !== requestTarget;
    if (initialLoad) {
      setLoading(true);
      setError(null);
    }
    try {
      const [baseEntries, collections] = await Promise.all([
        queryCollectionEntries({
          spacePath,
          collectionPath,
          filters: queryArgs.filters,
          sort: queryArgs.sort,
          includeNested,
          projectPath,
        }),
        listCollectionInfos(spacePath).catch(() => []),
      ]);
      const collectionPaths = new Set(collections.map((item) => item.path));
      const schemaPairs = await Promise.all(
        collections
          .filter((item) => item.path !== collectionPath)
          .map(async (item) => {
            try {
              const nestedSchema = await getCollectionSchema({
                spacePath,
                collectionPath: item.path,
              });
              return [item.path, normalizeSchema(nestedSchema)] as const;
            } catch {
              return null;
            }
          }),
      );
      const nextNestedSchemas = new Map(
        schemaPairs.filter((item) => item !== null),
      );
      const nestedParentPaths = Array.from(
        new Set(
          baseEntries
            .map((entry) => entryCollectionPath(entry))
            .filter(
              (path) => path !== collectionPath && collectionPaths.has(path),
            ),
        ),
      );
      const nestedEntryBatches = await Promise.all(
        nestedParentPaths.map(async (nestedPath) => {
          const nestedSchema = nextNestedSchemas.get(nestedPath);
          const nestedTableView = (
            (nestedSchema?.views ?? []) as CollectionView[]
          ).find((item) => item?.type === "table");
          try {
            return await queryCollectionEntries({
              spacePath,
              collectionPath: nestedPath,
              filters: nestedTableView?.filter ?? null,
              sort: nestedTableView?.sort ?? null,
              includeNested: nestedTableView
                ? showNestedForView(nestedTableView)
                : true,
              projectPath,
            });
          } catch (nestedLoadError) {
            console.warn(
              "Failed to load nested table entries:",
              nestedLoadError,
            );
            return [];
          }
        }),
      );
      const entriesByPath = new Map<string, Entry>();
      [...baseEntries, ...nestedEntryBatches.flat()].forEach((entry) => {
        entriesByPath.set(entry.path, entry);
      });
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      setEntries((current) =>
        mergeStableEntriesByPath(current, Array.from(entriesByPath.values())),
      );
      setNestedSchemas(nextNestedSchemas);
      setNestedCollectionPaths((current) =>
        sameStringSet(current, collectionPaths) ? current : collectionPaths,
      );
      loadedTargetRef.current = requestTarget;
      setError(null);
    } catch (loadError) {
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      console.warn("Failed to load table entries:", loadError);
      toast.error(m.table_error_title());
      if (initialLoad) setError(String(loadError));
    } finally {
      if (requestRef.current === request && targetRef.current === requestTarget)
        setLoading(false);
    }
  }, [
    collectionPath,
    includeNested,
    projectPath,
    queryArgs,
    spacePath,
    targetKey,
  ]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  return {
    entries,
    setEntries,
    nestedCollectionPaths,
    nestedSchemas,
    loading,
    error,
    loadEntries,
  };
}
