import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CollectionSchema } from "@/features/properties/model";
import {
  nextStoredQueryState,
  readStoredViewQuery,
  resolveViewQuery,
  viewStateStorageKey,
  viewUpdatePatch,
  writeStoredViewQuery,
} from "../model/query-utils";
import type {
  StoredViewQueryState,
  UseViewQueryOptions,
  UseViewQueryResult,
  ViewQueryPatch,
} from "../model/types";

interface SpaceSyncedEvent {
  projectPath?: string;
  spacePath?: string;
  path?: string;
}

interface FileEvent {
  path: string;
}

function isSchemaPath(path: string) {
  return path.split("/").pop() === "schema.yaml";
}

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
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    listen<FileEvent>("file:changed", (event) => {
      if (isSchemaPath(event.payload.path)) {
        reloadLocalQuery();
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    listen<SpaceSyncedEvent>("space:synced", (event) => {
      if (!event.payload.spacePath || event.payload.spacePath === spacePath) {
        reloadLocalQuery();
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
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
      const updated = await invoke<CollectionSchema>("update_view", {
        space: spacePath,
        collectionPath,
        viewName,
        patch: viewUpdatePatch(resolved.merged),
        projectPath: projectPath ?? null,
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

  return {
    ...resolved,
    ephemeral,
    storageKey,
    setLocalQuery,
    clearLocalQuery,
    saveForAll,
    reloadLocalQuery,
  };
}
