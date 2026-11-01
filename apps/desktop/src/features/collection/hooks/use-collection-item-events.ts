import { useEffect } from "react";
import {
  listenCollectionDataChanges,
  listenCollectionItemChanges,
} from "../api";

const COLLECTION_REFRESH_DEBOUNCE_MS = 75;

export function useCollectionRefreshEvents({
  spacePath,
  collectionPath,
  refreshSchema,
  refreshItems,
}: {
  spacePath: string;
  collectionPath: string;
  refreshSchema: () => Promise<void> | void;
  refreshItems: () => void;
}) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    let timer: number | null = null;
    const pending = {
      items: false,
      schema: false,
    };

    async function flush() {
      const schemaChanged = pending.schema;
      const itemsChanged = pending.items || schemaChanged;
      pending.schema = false;
      pending.items = false;

      try {
        if (schemaChanged) await refreshSchema();
      } catch (error) {
        if (!disposed) {
          console.warn("Failed to refresh collection schema:", error);
        }
      } finally {
        if (!disposed && itemsChanged) {
          refreshItems();
        }
      }
    }

    function schedule(kind: "items" | "schema") {
      if (kind === "schema") pending.schema = true;
      else pending.items = true;
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
  }, [collectionPath, refreshItems, refreshSchema, spacePath]);
}

export function useCollectionItemEvents({
  spacePath,
  collectionPath,
  onItemsChanged,
}: {
  spacePath: string;
  collectionPath: string;
  onItemsChanged: () => void;
}) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listenCollectionItemChanges({
      spacePath,
      collectionPath,
      onItemsChanged,
    })
      .then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch((error) => {
        if (!disposed) {
          console.warn("Failed to listen for collection item changes:", error);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [collectionPath, onItemsChanged, spacePath]);
}
