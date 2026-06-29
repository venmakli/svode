import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  listCollectionInfos,
  queryCalendarEntries,
} from "@/features/collection/api";
import { useStableViewQueryArgs } from "@/features/collection/query/hooks";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import {
  useEntryFieldSave,
  type EntryFieldSavePolicy,
} from "@/features/entry/field-save";
import type { Entry } from "@/features/entry";
import {
  collectionEntriesTargetKey,
  mergeStableEntriesByPath,
  sameStringSet,
} from "../../lib/entry-refresh";
import * as m from "@/paraglide/messages.js";

export function useCalendarEntries({
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
      const [baseEntries, collections] = await Promise.all([
        queryCalendarEntries({
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
      setEntries((current) => mergeStableEntriesByPath(current, baseEntries));
      const collectionPaths = new Set(collections.map((item) => item.path));
      setNestedCollectionPaths((current) =>
        sameStringSet(current, collectionPaths) ? current : collectionPaths,
      );
      loadedTargetRef.current = requestTarget;
    } catch (error) {
      if (requestRef.current !== request || targetRef.current !== requestTarget)
        return;
      console.warn("Failed to load calendar entries:", error);
      toast.error(m.calendar_error_title());
    } finally {
      if (requestRef.current === request && targetRef.current === requestTarget)
        setLoading(false);
    }
  }, [collectionPath, projectPath, queryArgs, spacePath, targetKey]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
    },
    [],
  );
  const saveEntryField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
  });

  const updateField = useCallback(
    async (
      entry: Entry,
      field: string,
      value: unknown,
      options?: { revert?: () => void; policy?: EntryFieldSavePolicy },
    ) => {
      try {
        await saveEntryField(entry, field, value, {
          policy: options?.policy,
          flush: true,
        });
      } catch (error) {
        console.warn("Failed to update calendar field:", error);
        options?.revert?.();
        toast.error(m.calendar_move_error());
        void loadEntries();
      }
    },
    [loadEntries, saveEntryField],
  );

  return {
    entries,
    setEntries,
    nestedCollectionPaths,
    loading,
    loadEntries,
    updateField,
  };
}
