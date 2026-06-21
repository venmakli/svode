import { useEffect } from "react";
import {
  listenWatchedSpaceDirty,
  listenWatchedSpaceFileEvent,
  readWatchedSpaceEntry,
  unwatchSpaceFiles,
  watchSpaceFiles,
} from "../api/space-watch-actions";
import {
  applySpaceFileEvent,
  isSameSpaceFileEvent,
  shouldApplySpaceFileEvent,
  SPACE_FILE_EVENT_BATCH_MS,
  SPACE_FILE_EVENT_NAMES,
  type QueuedSpaceFileEvent,
} from "../lib/space-file-watch-events";
import {
  selectActiveSpaceId,
  selectActiveSpacePath,
  useSpaceStore,
} from "../model";

export function useSpaceFileWatch() {
  const watchSpacePath = useSpaceStore(selectActiveSpacePath);
  const watchSpaceId = useSpaceStore(selectActiveSpaceId);

  useEffect(() => {
    if (!watchSpacePath || !watchSpaceId) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const queue: QueuedSpaceFileEvent[] = [];
    const unlisteners: Array<() => void> = [];

    const repairTree = (parentPath?: string | null) => {
      const store = useSpaceStore.getState();
      store.markTreeParentDirty(watchSpaceId, parentPath);
      void store.loadTreeChildren(watchSpaceId, parentPath, { force: true });
    };

    const flushQueue = () => {
      timer = null;
      const batch = queue.splice(0, queue.length);
      if (batch.length === 0 || disposed) return;

      void (async () => {
        for (const { eventName, payload } of batch) {
          if (!shouldApplySpaceFileEvent(payload, watchSpacePath)) {
            continue;
          }
          try {
            await applySpaceFileEvent({
              eventName,
              getStore: () => useSpaceStore.getState(),
              payload,
              readEntry: (entryPath) =>
                readWatchedSpaceEntry(watchSpacePath, entryPath),
              repairTree,
              spaceId: watchSpaceId,
            });
          } catch (error) {
            console.warn("Failed to apply space tree event:", error);
            repairTree(payload.parentPath);
          }
        }
      })();
    };

    const enqueue = (
      eventName: QueuedSpaceFileEvent["eventName"],
      payload: QueuedSpaceFileEvent["payload"],
    ) => {
      queue.push({ eventName, payload });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushQueue, SPACE_FILE_EVENT_BATCH_MS);
    };

    watchSpaceFiles(watchSpacePath).catch((error) =>
      console.error("Failed to watch space:", error),
    );

    for (const eventName of SPACE_FILE_EVENT_NAMES) {
      listenWatchedSpaceFileEvent(eventName, (event) =>
        enqueue(eventName, event.payload),
      ).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }

    listenWatchedSpaceDirty((event) => {
      if (!isSameSpaceFileEvent(event.payload, watchSpacePath)) return;
      if (!event.payload.affectsTree) return;
      useSpaceStore.getState().markTreeDirty(watchSpaceId);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const unlisten of unlisteners) unlisten();
      unwatchSpaceFiles(watchSpacePath).catch((error) =>
        console.error("Failed to unwatch space:", error),
      );
    };
  }, [watchSpaceId, watchSpacePath]);
}
