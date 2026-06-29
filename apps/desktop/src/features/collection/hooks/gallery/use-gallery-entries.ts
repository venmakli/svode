import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStableViewQueryArgs } from "@/features/collection/query/hooks";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import { listCollectionInfos, queryCollectionEntries } from "../../api";
import {
  collectionEntriesTargetKey,
  mergeStableEntriesByPath,
  sameStringSet,
} from "../../lib/entry-refresh";
import * as m from "@/paraglide/messages.js";

export function useGalleryEntries({
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
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(true);
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
    if (initialLoad) setLoading(true);
    try {
      const [nextEntries, collections] = await Promise.all([
        queryCollectionEntries({
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
      setEntries((current) => mergeStableEntriesByPath(current, nextEntries));
      const collectionPaths = new Set(collections.map((item) => item.path));
      setNestedCollectionPaths((current) =>
        sameStringSet(current, collectionPaths) ? current : collectionPaths,
      );
      loadedTargetRef.current = requestTarget;
    } catch (error) {
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      console.warn("Failed to load gallery entries:", error);
      toast.error(m.table_error_title());
    } finally {
      if (requestRef.current === request && targetRef.current === requestTarget)
        setLoading(false);
    }
  }, [collectionPath, projectPath, queryArgs, spacePath, targetKey]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  return {
    entries,
    setEntries,
    nestedCollectionPaths,
    loading,
    loadEntries,
  };
}
