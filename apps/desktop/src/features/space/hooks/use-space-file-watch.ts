import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import {
  listenWatchedSpaceDirty,
  listenWatchedSpaceFileEvent,
  readWatchedSpacePage,
  unwatchSpaceFiles,
  watchSpaceFiles,
} from "../api/space-watch-actions";
import {
  applySpaceFileEventBatch,
  isSameSpaceFileEvent,
  SPACE_FILE_EVENT_BATCH_MS,
  SPACE_FILE_EVENT_NAMES,
  type QueuedSpaceFileEvent,
  type ResolvedSpaceFileEvent,
} from "../lib/space-file-watch-events";
import { useSpaceStore, type SpaceState } from "../model";

const WATCH_TARGET_SEPARATOR = "\0";

function encodeWatchTarget(spaceId: string, spacePath: string): string {
  return `${spaceId}${WATCH_TARGET_SEPARATOR}${spacePath}`;
}

function decodeWatchTarget(target: string) {
  const separatorIndex = target.indexOf(WATCH_TARGET_SEPARATOR);
  return {
    spaceId: target.slice(0, separatorIndex),
    spacePath: target.slice(separatorIndex + WATCH_TARGET_SEPARATOR.length),
  };
}

function selectWatchTargetKeys(state: SpaceState): string[] {
  const targets: string[] = [];
  const seenPaths = new Set<string>();

  const addTarget = (spaceId: string | null, spacePath: string | null) => {
    if (!spaceId || !spacePath || seenPaths.has(spacePath)) return;
    seenPaths.add(spacePath);
    targets.push(encodeWatchTarget(spaceId, spacePath));
  };

  addTarget(state.activeRootId, state.activeRootPath);
  for (const space of state.spaces) {
    if (space.status !== "ready") continue;
    addTarget(space.id, space.path);
  }

  return targets;
}

export function useSpaceFileWatch() {
  const watchTargetKeys = useSpaceStore(useShallow(selectWatchTargetKeys));

  useEffect(() => {
    if (watchTargetKeys.length === 0) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let flushing = false;
    const queue: ResolvedSpaceFileEvent[] = [];
    const unlisteners: Array<() => void> = [];
    const watchTargets = watchTargetKeys.map(decodeWatchTarget);
    const targetByPath = new Map(
      watchTargets.map((target) => [target.spacePath, target]),
    );

    const resolveEventTarget = (payload: { space?: string }) => {
      if (payload.space) {
        return targetByPath.get(payload.space) ?? null;
      }
      return watchTargets.length === 1 ? watchTargets[0] : null;
    };

    const flushQueue = () => {
      timer = null;
      if (flushing) return;
      const batch = queue.splice(0, queue.length);
      if (batch.length === 0 || disposed) return;
      flushing = true;

      void applySpaceFileEventBatch({
        events: batch,
        getStore: () => useSpaceStore.getState(),
        readPage: readWatchedSpacePage,
      }).finally(() => {
        flushing = false;
        if (queue.length > 0 && !disposed) {
          timer = setTimeout(flushQueue, SPACE_FILE_EVENT_BATCH_MS);
        }
      });
    };

    const enqueue = (
      eventName: QueuedSpaceFileEvent["eventName"],
      payload: QueuedSpaceFileEvent["payload"],
    ) => {
      const target = resolveEventTarget(payload);
      if (!target) return;
      queue.push({ eventName, payload, ...target });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushQueue, SPACE_FILE_EVENT_BATCH_MS);
    };

    for (const eventName of SPACE_FILE_EVENT_NAMES) {
      listenWatchedSpaceFileEvent(eventName, (event) =>
        enqueue(eventName, event.payload),
      ).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }

    listenWatchedSpaceDirty((event) => {
      const target = resolveEventTarget(event.payload);
      if (!target) return;
      if (!isSameSpaceFileEvent(event.payload, target.spacePath)) return;
      if (!event.payload.affectsTree) return;
      useSpaceStore.getState().markTreeDirty(target.spaceId);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    for (const { spacePath } of watchTargets) {
      watchSpaceFiles(spacePath).catch((error) =>
        console.error("Failed to watch space:", error),
      );
    }

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const unlisten of unlisteners) unlisten();
      for (const { spacePath } of watchTargets) {
        unwatchSpaceFiles(spacePath).catch((error) =>
          console.error("Failed to unwatch space:", error),
        );
      }
    };
  }, [watchTargetKeys]);
}
