import { useEffect } from "react";
import { listenCollectionEntryChanges } from "../api";

export function useCollectionEntryEvents(onEntriesChanged: () => void) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listenCollectionEntryChanges(onEntriesChanged).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onEntriesChanged]);
}
