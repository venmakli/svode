import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
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
  repairParentPathForSpaceFileEvent,
  shouldApplySpaceFileEvent,
  SPACE_FILE_EVENT_BATCH_MS,
  SPACE_FILE_EVENT_NAMES,
  type QueuedSpaceFileEvent,
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

type ResolvedSpaceFileEvent = QueuedSpaceFileEvent & {
  spaceId: string;
  spacePath: string;
};

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
    const targetById = new Map(
      watchTargets.map((target) => [target.spaceId, target]),
    );

    const resolveEventTarget = (payload: { space?: string }) => {
      if (payload.space) {
        return targetByPath.get(payload.space) ?? null;
      }
      return watchTargets.length === 1 ? watchTargets[0] : null;
    };

    const flushRepairs = async (
      repairsBySpace: Map<string, Set<string | null>>,
    ) => {
      for (const [spaceId, parents] of repairsBySpace) {
        if (!targetById.has(spaceId)) continue;
        const store = useSpaceStore.getState();
        for (const parentPath of parents) {
          store.markTreeParentDirty(spaceId, parentPath);
          await store.loadTreeChildren(spaceId, parentPath, { force: true });
        }
      }
    };

    const flushQueue = () => {
      timer = null;
      if (flushing) return;
      const batch = queue.splice(0, queue.length);
      if (batch.length === 0 || disposed) return;
      flushing = true;

      void (async () => {
        const repairsBySpace = new Map<string, Set<string | null>>();
        const queueRepair = (spaceId: string, parentPath?: string | null) => {
          const parent = parentPath ?? null;
          const parents =
            repairsBySpace.get(spaceId) ?? new Set<string | null>();
          parents.add(parent);
          repairsBySpace.set(spaceId, parents);
        };

        for (const { eventName, payload, spaceId, spacePath } of batch) {
          if (!shouldApplySpaceFileEvent(payload, spacePath)) {
            continue;
          }
          if (payload.affectsTree) {
            queueRepair(spaceId, repairParentPathForSpaceFileEvent(payload));
          }
          try {
            await applySpaceFileEvent({
              eventName,
              getStore: () => useSpaceStore.getState(),
              payload,
              readEntry: (entryPath) =>
                readWatchedSpaceEntry(spacePath, entryPath),
              repairTree: (parentPath) => queueRepair(spaceId, parentPath),
              spaceId,
            });
          } catch (error) {
            console.warn("Failed to apply space tree event:", error);
            queueRepair(
              spaceId,
              repairParentPathForSpaceFileEvent(payload) ?? payload.parentPath,
            );
          }
        }

        await flushRepairs(repairsBySpace);
      })().finally(() => {
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
