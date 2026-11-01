import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStableViewQueryArgs } from "@/features/collection/query/hooks";
import {
  type CollectionView,
  type QueryFilter,
  type QuerySort,
} from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import {
  getCollectionSchema,
  listCollectionInfos,
  queryCollectionItems,
} from "../../api";
import { itemCollectionPath } from "../../lib/item-tree";
import {
  collectionItemsTargetKey,
  mergeStableItemsByPath,
  rebaseCollectionItems,
  rebaseCollectionPath,
  rebaseCollectionPathSet,
  sameStringSet,
} from "../../lib/item-refresh";
import { showNestedForView } from "../../lib/view-options";
import * as m from "@/paraglide/messages.js";

export function useTableItems({
  collectionPath,
  previousCollectionPath = null,
  filters,
  includeNested,
  projectPath,
  refreshToken,
  sort,
  spacePath,
}: {
  collectionPath: string;
  previousCollectionPath?: string | null;
  filters: QueryFilter[];
  includeNested: boolean;
  projectPath?: string | null;
  refreshToken: number;
  sort: QuerySort[];
  spacePath: string;
}) {
  const [items, setItems] = useState<Page[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [nestedSchemas, setNestedSchemas] = useState<
    Map<string, CollectionSchema>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const targetKey = collectionItemsTargetKey({
    collectionPath,
    projectPath,
    spacePath,
  });
  const previousTargetKey = previousCollectionPath
    ? collectionItemsTargetKey({
        collectionPath: previousCollectionPath,
        projectPath,
        spacePath,
      })
    : null;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const loadedTargetRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const queryArgs = useStableViewQueryArgs(filters, sort);

  const loadItems = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    const requestTarget = targetKey;
    const initialLoad = loadedTargetRef.current !== requestTarget;
    const retargeting =
      initialLoad && loadedTargetRef.current === previousTargetKey;
    if (retargeting && previousCollectionPath) {
      setItems((current) =>
        rebaseCollectionItems(current, previousCollectionPath, collectionPath),
      );
      setNestedCollectionPaths((current) =>
        rebaseCollectionPathSet(
          current,
          previousCollectionPath,
          collectionPath,
        ),
      );
      setNestedSchemas((current) => {
        const next = new Map<string, CollectionSchema>();
        for (const [path, schema] of current) {
          next.set(
            rebaseCollectionPath(path, previousCollectionPath, collectionPath),
            schema,
          );
        }
        return next;
      });
      loadedTargetRef.current = requestTarget;
      setLoading(false);
      setError(null);
    } else if (initialLoad) {
      setLoading(true);
      setError(null);
    }
    try {
      const [baseItems, collections] = await Promise.all([
        queryCollectionItems({
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
          baseItems
            .map((item) => itemCollectionPath(item))
            .filter(
              (path) => path !== collectionPath && collectionPaths.has(path),
            ),
        ),
      );
      const nestedItemBatches = await Promise.all(
        nestedParentPaths.map(async (nestedPath) => {
          const nestedSchema = nextNestedSchemas.get(nestedPath);
          const nestedTableView = (
            (nestedSchema?.views ?? []) as CollectionView[]
          ).find((item) => item?.type === "table");
          try {
            return await queryCollectionItems({
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
            console.warn("Failed to load nested table items:", nestedLoadError);
            return [];
          }
        }),
      );
      const itemsByPath = new Map<string, Page>();
      [...baseItems, ...nestedItemBatches.flat()].forEach((item) => {
        itemsByPath.set(item.path, item);
      });
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      setItems((current) =>
        mergeStableItemsByPath(current, Array.from(itemsByPath.values())),
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
      console.warn("Failed to load table items:", loadError);
      toast.error(m.table_error_title());
      if (initialLoad && !retargeting) setError(String(loadError));
    } finally {
      if (requestRef.current === request && targetRef.current === requestTarget)
        setLoading(false);
    }
  }, [
    collectionPath,
    includeNested,
    previousCollectionPath,
    previousTargetKey,
    projectPath,
    queryArgs,
    spacePath,
    targetKey,
  ]);

  useLayoutEffect(() => {
    void loadItems();
  }, [loadItems, refreshToken]);

  return {
    items,
    setItems,
    nestedCollectionPaths,
    nestedSchemas,
    loading,
    error,
    loadItems,
  };
}
