import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useStableViewQueryArgs,
  type QueryFilter,
  type QuerySort,
} from "@/features/collection/query";
import type { Entry } from "@/features/entry";
import {
  listCollectionInfos,
  queryCollectionEntries,
} from "../../api";
import * as m from "@/paraglide/messages.js";

export function useBoardEntries({
  collectionPath,
  filters,
  projectPath,
  refreshToken,
  sort,
  spacePath,
}: {
  collectionPath: string;
  filters: QueryFilter[];
  projectPath?: string | null;
  refreshToken: number;
  sort: QuerySort[];
  spacePath: string;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [manualOrderEntries, setManualOrderEntries] = useState<Entry[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(true);
  const queryArgs = useStableViewQueryArgs(filters, sort);

  const loadEntries = useCallback(async () => {
    const hasActiveSort = queryArgs.sort.length > 0;
    setLoading(true);
    try {
      const [baseEntries, orderEntries, collections] = await Promise.all([
        queryCollectionEntries({
          spacePath,
          collectionPath,
          filters: queryArgs.filters,
          sort: queryArgs.sort,
          includeNested: false,
          projectPath,
        }),
        hasActiveSort
          ? Promise.resolve<Entry[]>([])
          : queryCollectionEntries({
              spacePath,
              collectionPath,
              filters: null,
              sort: null,
              includeNested: false,
              projectPath,
            }),
        listCollectionInfos(spacePath).catch(() => []),
      ]);
      setEntries(baseEntries);
      setManualOrderEntries(hasActiveSort ? baseEntries : orderEntries);
      setNestedCollectionPaths(new Set(collections.map((item) => item.path)));
    } catch (error) {
      console.warn("Failed to load board entries:", error);
      toast.error(m.board_error_title());
    } finally {
      setLoading(false);
    }
  }, [collectionPath, projectPath, queryArgs, spacePath]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  return {
    entries,
    setEntries,
    manualOrderEntries,
    setManualOrderEntries,
    nestedCollectionPaths,
    loading,
    loadEntries,
  };
}
