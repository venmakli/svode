import { useEffect } from "react";
import { listenCollectionEntryChanges } from "../api";

export function useCollectionEntryEvents({
  spacePath,
  onEntriesChanged,
}: {
  spacePath: string;
  onEntriesChanged: () => void;
}) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listenCollectionEntryChanges({ spacePath, onEntriesChanged })
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
  }, [onEntriesChanged, spacePath]);
}
