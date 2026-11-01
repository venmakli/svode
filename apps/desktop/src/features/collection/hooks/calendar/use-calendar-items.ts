import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  listCollectionInfos,
  queryCalendarItems,
} from "@/features/collection/api";
import { useStableViewQueryArgs } from "@/features/collection/query/hooks";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import {
  usePageFieldSave,
  type PageFieldSavePolicy,
} from "@/features/page/field-save";
import type { Page } from "@/features/page";
import {
  collectionItemsTargetKey,
  mergeStableItemsByPath,
  rebaseCollectionItems,
  rebaseCollectionPathSet,
  sameStringSet,
} from "../../lib/item-refresh";
import * as m from "@/paraglide/messages.js";
import { useSignalUserEdit } from "@/features/navigation";

export function useCalendarItems({
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
      const [baseItems, collections] = await Promise.all([
        queryCalendarItems({
          spacePath,
          collectionPath,
          filters: queryArgs.filters,
          sort: queryArgs.sort,
          projectPath,
        }),
        listCollectionInfos(spacePath).catch(() => []),
      ]);
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      setItems((current) => mergeStableItemsByPath(current, baseItems));
      const collectionPaths = new Set(collections.map((item) => item.path));
      setNestedCollectionPaths((current) =>
        sameStringSet(current, collectionPaths) ? current : collectionPaths,
      );
      loadedTargetRef.current = requestTarget;
    } catch (error) {
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      console.warn("Failed to load calendar items:", error);
      toast.error(m.calendar_error_title());
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

  const applyPageUpdate = useCallback(
    (itemPath: string, update: (item: Page) => Page) => {
      setItems((current) =>
        current.map((item) => (item.path === itemPath ? update(item) : item)),
      );
    },
    [],
  );
  const signalUserEdit = useSignalUserEdit();
  const { save: saveItemField } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
    onSaved: signalUserEdit,
  });

  const updateField = useCallback(
    async (
      item: Page,
      field: string,
      value: unknown,
      options?: { revert?: () => void; policy?: PageFieldSavePolicy },
    ) => {
      try {
        await saveItemField(item, field, value, {
          policy: options?.policy,
          flush: true,
        });
      } catch (error) {
        console.warn("Failed to update calendar field:", error);
        options?.revert?.();
        toast.error(m.calendar_move_error());
        void loadItems();
      }
    },
    [loadItems, saveItemField],
  );

  return {
    items,
    setItems,
    nestedCollectionPaths,
    loading,
    loadItems,
    updateField,
  };
}
