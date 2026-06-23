import { useEffect } from "react";
import { listen } from "@/platform/native/events";

interface FileEvent {
  path: string;
}

function isMarkdownEntryPath(path: string) {
  return path.replace(/\\/g, "/").toLowerCase().endsWith(".md");
}

export function useCollectionEntryEvents(onEntriesChanged: () => void) {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const reloadEntries = (event: { payload: FileEvent }) => {
      if (!isMarkdownEntryPath(event.payload.path)) return;
      onEntriesChanged();
    };

    for (const eventName of ["file:created", "file:changed", "file:deleted"]) {
      listen<FileEvent>(eventName, reloadEntries).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [onEntriesChanged]);
}
