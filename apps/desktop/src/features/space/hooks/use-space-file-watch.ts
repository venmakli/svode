import { useEffect } from "react";
import {
  listenWatchedSpaceDirty,
  listenWatchedSpaceFileEvent,
  readWatchedSpaceEntry,
  unwatchSpaceFiles,
  watchSpaceFiles,
  type SpaceFileEventName,
  type SpaceFileEventDto,
  type WatchedSpaceEntry,
} from "../api/space-watch-actions";
import type { TreeNode } from "@/features/entry";
import {
  basename,
  dirname,
  folderPathForSchema,
  isReadmePath,
  normalizeTreePath,
  parentPathForTreeEvent,
} from "../lib/tree-patches";
import {
  selectActiveSpaceId,
  selectActiveSpacePath,
  useSpaceStore,
} from "../model";

const FILE_EVENT_NAMES: SpaceFileEventName[] = [
  "file:created",
  "file:changed",
  "file:deleted",
];
const FILE_EVENT_BATCH_MS = 300;

type QueuedSpaceFileEvent = {
  eventName: SpaceFileEventName;
  payload: SpaceFileEventDto;
};

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function isSchemaPath(path: string): boolean {
  return basename(path) === "schema.yaml";
}

function inferEventKind(payload: SpaceFileEventDto) {
  if (payload.kind) return payload.kind;
  if (isSchemaPath(payload.path)) return "schema";
  if (isMarkdownPath(payload.path)) return "document";
  if (payload.isDir) return "folder";
  return "unknown";
}

function affectsTreeOrMetadata(payload: SpaceFileEventDto): boolean {
  if (payload.affectsTree === false && payload.affectsMetadata === false) {
    return false;
  }
  return inferEventKind(payload) !== "unknown";
}

function isSameSpace(payload: { space?: string }, spacePath: string): boolean {
  return !payload.space || payload.space === spacePath;
}

function entryToTreeNode(
  entryPath: string,
  entry: WatchedSpaceEntry,
  parentPath?: string | null,
): TreeNode {
  return {
    name: basename(entryPath),
    path: normalizeTreePath(entryPath),
    title: entry.meta.title,
    icon: entry.meta.icon,
    description: entry.meta.description,
    has_changes: false,
    has_schema: false,
    parent: parentPath ?? dirname(entryPath),
    kind: "document",
    hasChildren: false,
    children: [],
  };
}

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

    const handleCreated = async (payload: SpaceFileEventDto) => {
      const store = useSpaceStore.getState();
      const path = normalizeTreePath(payload.path);
      const kind = inferEventKind(payload);
      if (kind === "schema") {
        store.updateNodeSchema(watchSpaceId, folderPathForSchema(path), true);
        return;
      }
      if (kind === "folder") {
        const parentPath = parentPathForTreeEvent(path, payload.parentPath);
        store.upsertTreeNode(watchSpaceId, parentPath, {
          name: basename(path),
          path,
          title: basename(path),
          icon: null,
          description: null,
          has_changes: false,
          has_schema: false,
          parent: parentPath,
          kind: "folder",
          hasChildren: false,
          children: [],
        });
        return;
      }
      if (kind !== "document") return;

      const entry = await readWatchedSpaceEntry(watchSpacePath, path);
      if (isReadmePath(path)) {
        if (!dirname(path)) {
          store.upsertTreeNode(
            watchSpaceId,
            "",
            entryToTreeNode(path, entry, ""),
          );
          return;
        }
        store.applyReadmeMeta(
          watchSpaceId,
          path,
          entry.meta.title,
          entry.meta.icon,
          entry.meta.description,
        );
        return;
      }
      store.upsertTreeNode(
        watchSpaceId,
        parentPathForTreeEvent(path, payload.parentPath),
        entryToTreeNode(
          path,
          entry,
          parentPathForTreeEvent(path, payload.parentPath),
        ),
      );
    };

    const handleChanged = async (payload: SpaceFileEventDto) => {
      const store = useSpaceStore.getState();
      const path = normalizeTreePath(payload.path);
      const kind = inferEventKind(payload);
      if (kind === "schema") {
        store.updateNodeSchema(watchSpaceId, folderPathForSchema(path), true);
        return;
      }
      if (kind === "folder") {
        repairTree(parentPathForTreeEvent(path, payload.parentPath));
        return;
      }
      if (kind !== "document") return;

      const entry = await readWatchedSpaceEntry(watchSpacePath, path);
      if (isReadmePath(path) && dirname(path)) {
        store.applyReadmeMeta(
          watchSpaceId,
          path,
          entry.meta.title,
          entry.meta.icon,
          entry.meta.description,
        );
        return;
      }
      store.updateNodeMeta(
        watchSpaceId,
        path,
        entry.meta.title,
        entry.meta.icon,
        entry.meta.description,
      );
    };

    const handleDeleted = (payload: SpaceFileEventDto) => {
      const store = useSpaceStore.getState();
      const path = normalizeTreePath(payload.path);
      const kind = inferEventKind(payload);
      if (kind === "schema") {
        store.updateNodeSchema(watchSpaceId, folderPathForSchema(path), false);
        return;
      }
      if (kind === "document" && isReadmePath(path)) {
        store.removeReadmeMeta(watchSpaceId, path);
        return;
      }
      if (kind === "document" || kind === "folder") {
        store.removeTreePath(watchSpaceId, path);
      }
    };

    const flushQueue = () => {
      timer = null;
      const batch = queue.splice(0, queue.length);
      if (batch.length === 0 || disposed) return;

      void (async () => {
        for (const { eventName, payload } of batch) {
          if (
            !isSameSpace(payload, watchSpacePath) ||
            !affectsTreeOrMetadata(payload)
          ) {
            continue;
          }
          try {
            if (inferEventKind(payload) === "unknown") {
              repairTree(payload.parentPath);
              continue;
            }
            if (eventName === "file:created") {
              await handleCreated(payload);
            } else if (eventName === "file:changed") {
              await handleChanged(payload);
            } else {
              handleDeleted(payload);
            }
          } catch (error) {
            console.warn("Failed to apply space tree event:", error);
            repairTree(payload.parentPath);
          }
        }
      })();
    };

    const enqueue = (
      eventName: SpaceFileEventName,
      payload: SpaceFileEventDto,
    ) => {
      queue.push({ eventName, payload });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushQueue, FILE_EVENT_BATCH_MS);
    };

    watchSpaceFiles(watchSpacePath).catch((error) =>
      console.error("Failed to watch space:", error),
    );

    for (const eventName of FILE_EVENT_NAMES) {
      listenWatchedSpaceFileEvent(eventName, (event) =>
        enqueue(eventName, event.payload),
      ).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }

    listenWatchedSpaceDirty((event) => {
      if (!isSameSpace(event.payload, watchSpacePath)) return;
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
