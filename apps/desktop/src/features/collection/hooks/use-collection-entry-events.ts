import { useEffect } from "react";
import {
  listenCollectionDataChanges,
  listenCollectionEntryChanges,
} from "../api";

const COLLECTION_REFRESH_DEBOUNCE_MS = 75;

export function useCollectionRefreshEvents({
  spacePath,
  collectionPath,
  refreshSchema,
  refreshEntries,
}: {
  spacePath: string;
  collectionPath: string;
  refreshSchema: () => Promise<void> | void;
  refreshEntries: () => void;
}) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    let timer: ReturnType<typeof window.setTimeout> | null = null;
    const pending = {
      entries: false,
      schema: false,
    };

    async function flush() {
      const schemaChanged = pending.schema;
      const entriesChanged = pending.entries || schemaChanged;
      pending.schema = false;
      pending.entries = false;

      try {
        if (schemaChanged) await refreshSchema();
      } catch (error) {
        if (!disposed) {
          console.warn("Failed to refresh collection schema:", error);
        }
      } finally {
        if (!disposed && entriesChanged) {
          refreshEntries();
        }
      }
    }

    function schedule(kind: "entries" | "schema") {
      if (kind === "schema") pending.schema = true;
      else pending.entries = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void flush();
      }, COLLECTION_REFRESH_DEBOUNCE_MS);
    }

    listenCollectionDataChanges({
      spacePath,
      collectionPath,
      onDataChanged: schedule,
    })
      .then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch((error) => {
        if (!disposed) {
          console.warn("Failed to listen for collection file changes:", error);
        }
      });

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [collectionPath, refreshEntries, refreshSchema, spacePath]);
}

export function useCollectionEntryEvents({
  spacePath,
  collectionPath,
  onEntriesChanged,
}: {
  spacePath: string;
  collectionPath: string;
  onEntriesChanged: () => void;
}) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listenCollectionEntryChanges({
      spacePath,
      collectionPath,
      onEntriesChanged,
    })
      .then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch((error) => {
        if (!disposed) {
          console.warn("Failed to listen for collection entry changes:", error);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [collectionPath, onEntriesChanged, spacePath]);
}
