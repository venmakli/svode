import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  listCollectionInfos,
  queryCalendarEntries,
} from "@/features/collection/api";
import {
  useStableViewQueryArgs,
  type QueryFilter,
  type QuerySort,
} from "@/features/collection/query";
import {
  useEntryFieldSave,
  type Entry,
  type EntryFieldSavePolicy,
} from "@/features/entry";
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
  const queryArgs = useStableViewQueryArgs(filters, sort);

  const loadEntries = useCallback(async () => {
    setLoading(true);
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
      setEntries(baseEntries);
      setNestedCollectionPaths(new Set(collections.map((item) => item.path)));
    } catch (error) {
      console.warn("Failed to load calendar entries:", error);
      toast.error(m.calendar_error_title());
    } finally {
      setLoading(false);
    }
  }, [collectionPath, projectPath, queryArgs, spacePath]);

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
