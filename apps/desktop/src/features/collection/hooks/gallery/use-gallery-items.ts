import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStableViewQueryArgs } from "@/features/collection/query/hooks";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import { listCollectionInfos, queryCollectionItems } from "../../api";
import {
  collectionItemsTargetKey,
  mergeStableItemsByPath,
  rebaseCollectionItems,
  rebaseCollectionPathSet,
  sameStringSet,
} from "../../lib/item-refresh";
import * as m from "@/paraglide/messages.js";

export function useGalleryItems({
  collectionPath,
  previousCollectionPath = null,
  filters,
  projectPath,
  refreshToken,
  sort,
  spacePath,
}: {
  collectionPath: string;
  previousCollectionPath?: string | null;
  filters: QueryFilter[];
  projectPath?: string | null;
  refreshToken: number;
  sort: QuerySort[];
  spacePath: string;
}) {
  const [items, setItems] = useState<Page[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(true);
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
      loadedTargetRef.current = requestTarget;
      setLoading(false);
    } else if (initialLoad) {
      setLoading(true);
    }
    try {
      const [nextItems, collections] = await Promise.all([
        queryCollectionItems({
          spacePath,
          collectionPath,
          filters: queryArgs.filters,
          sort: queryArgs.sort,
          includeNested: false,
          projectPath,
        }),
        listCollectionInfos(spacePath).catch(() => []),
      ]);
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      setItems((current) => mergeStableItemsByPath(current, nextItems));
      const collectionPaths = new Set(collections.map((item) => item.path));
      setNestedCollectionPaths((current) =>
        sameStringSet(current, collectionPaths) ? current : collectionPaths,
      );
      loadedTargetRef.current = requestTarget;
    } catch (error) {
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      console.warn("Failed to load gallery items:", error);
      toast.error(m.table_error_title());
    } finally {
      if (requestRef.current === request && targetRef.current === requestTarget)
        setLoading(false);
    }
  }, [
    collectionPath,
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
    loading,
    loadItems,
  };
}
