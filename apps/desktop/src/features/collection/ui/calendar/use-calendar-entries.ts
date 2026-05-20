import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  listCollectionInfos,
  queryCalendarEntries,
  updateCollectionEntryField,
} from "@/features/collection/api";
import {
  useStableViewQueryArgs,
  type QueryFilter,
  type QuerySort,
} from "@/features/collection/query";
import type { Entry } from "@/features/editor/types";
import { updateEntryDateValue } from "./utils";
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

  const updateField = useCallback(
    async (
      entry: Entry,
      field: string,
      value: unknown,
      revert?: () => void,
    ) => {
      setEntries((current) =>
        current.map((item) =>
          item.path === entry.path
            ? updateEntryDateValue(item, field, value)
            : item,
        ),
      );
      try {
        const updated = await updateCollectionEntryField({
          spacePath,
          filePath: entry.path,
          field,
          value,
          projectPath,
        });
        setEntries((current) =>
          current.map((item) => (item.path === entry.path ? updated : item)),
        );
      } catch (error) {
        console.warn("Failed to update calendar field:", error);
        revert?.();
        toast.error(m.calendar_move_error());
        void loadEntries();
      }
    },
    [loadEntries, projectPath, spacePath],
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
