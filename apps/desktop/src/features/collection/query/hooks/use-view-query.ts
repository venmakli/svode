import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listenCollectionQueryInvalidations,
  updateCollectionView,
} from "../../api";
import {
  nextStoredQueryState,
  resolveViewQuery,
  viewStateStorageKey,
  viewUpdatePatch,
} from "../model/query-utils";
import {
  readStoredViewQuery,
  writeStoredViewQuery,
} from "../lib/view-query-storage";
import type {
  StoredViewQueryState,
  UseViewQueryOptions,
  UseViewQueryResult,
  ViewQueryPatch,
} from "../model/types";

export function useViewQuery({
  spacePath,
  projectPath,
  collectionPath,
  viewName,
  schema,
  view,
}: UseViewQueryOptions): UseViewQueryResult {
  const storageKey = useMemo(
    () => viewStateStorageKey(collectionPath, viewName),
    [collectionPath, viewName],
  );
  const [ephemeralSnapshot, setEphemeralSnapshot] = useState<{
    storageKey: string;
    value: StoredViewQueryState | null;
  }>(() => ({
    storageKey,
    value:
      typeof window === "undefined" ? null : readStoredViewQuery(storageKey),
  }));
  const storedEphemeral =
    ephemeralSnapshot.storageKey === storageKey
      ? ephemeralSnapshot.value
      : typeof window === "undefined"
        ? null
        : readStoredViewQuery(storageKey);
  const ephemeral = view ? storedEphemeral : null;

  const reloadLocalQuery = useCallback(() => {
    setEphemeralSnapshot({
      storageKey,
      value: readStoredViewQuery(storageKey),
    });
  }, [storageKey]);

  const resolved = useMemo(
    () => resolveViewQuery(schema, view, ephemeral),
    [ephemeral, schema, view],
  );

  useEffect(() => {
    if (!view && storedEphemeral) {
      writeStoredViewQuery(storageKey, null);
    }
  }, [storageKey, storedEphemeral, view]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listenCollectionQueryInvalidations({
      spacePath,
      onQueryInvalidated: reloadLocalQuery,
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reloadLocalQuery, spacePath]);

  const setLocalQuery = useCallback(
    (patch: ViewQueryPatch) => {
      const next = nextStoredQueryState(
        ephemeral,
        patch,
        resolved.baseViewHash,
      );
      writeStoredViewQuery(storageKey, next);
      setEphemeralSnapshot({
        storageKey,
        value: readStoredViewQuery(storageKey),
      });
    },
    [ephemeral, resolved.baseViewHash, storageKey],
  );

  const clearLocalQuery = useCallback(
    (keys?: Array<keyof ViewQueryPatch>) => {
      if (!keys || keys.length === 0) {
        writeStoredViewQuery(storageKey, null);
        setEphemeralSnapshot({ storageKey, value: null });
        return;
      }
      const current = readStoredViewQuery(storageKey);
      if (!current) return;
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      writeStoredViewQuery(storageKey, next);
      setEphemeralSnapshot({
        storageKey,
        value: readStoredViewQuery(storageKey),
      });
    },
    [storageKey],
  );

  const saveForAll = useCallback(
    async (options?: {
      confirmOverwrite?: () => boolean | Promise<boolean>;
    }) => {
      if (!view || !resolved.hasLocalChanges || resolved.issues.length > 0)
        return null;
      if (resolved.sharedChanged) {
        const confirmed = await options?.confirmOverwrite?.();
        if (!confirmed) return null;
      }
      const updated = await updateCollectionView({
        spacePath,
        collectionPath,
        viewName,
        patch: viewUpdatePatch(resolved.merged),
        projectPath,
      });
      writeStoredViewQuery(storageKey, null);
      setEphemeralSnapshot({ storageKey, value: null });
      return updated;
    },
    [
      collectionPath,
      projectPath,
      resolved.hasLocalChanges,
      resolved.issues.length,
      resolved.merged,
      resolved.sharedChanged,
      spacePath,
      storageKey,
      view,
      viewName,
    ],
  );

  return useMemo(
    () => ({
      ...resolved,
      ephemeral,
      storageKey,
      setLocalQuery,
      clearLocalQuery,
      saveForAll,
      reloadLocalQuery,
    }),
    [
      clearLocalQuery,
      ephemeral,
      reloadLocalQuery,
      resolved,
      saveForAll,
      setLocalQuery,
      storageKey,
    ],
  );
}
