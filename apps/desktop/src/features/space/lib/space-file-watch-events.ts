import type { TreeNode } from "@/features/entry";
import type {
  SpaceFileEventDto,
  SpaceFileEventName,
  WatchedSpaceEntry,
} from "../api/space-watch-actions";
import {
  basename,
  dirname,
  folderPathForSchema,
  isReadmePath,
  normalizeTreePath,
  parentPathForTreeEvent,
} from "./tree-patches";

export const SPACE_FILE_EVENT_NAMES: SpaceFileEventName[] = [
  "file:created",
  "file:changed",
  "file:deleted",
];
export const SPACE_FILE_EVENT_BATCH_MS = 300;

export type QueuedSpaceFileEvent = {
  eventName: SpaceFileEventName;
  payload: SpaceFileEventDto;
};

export interface SpaceFileEventTreeStore {
  applyReadmeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
  removeReadmeMeta: (spaceId: string, path: string) => void;
  removeTreePath: (spaceId: string, path: string) => void;
  updateNodeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
  updateNodeSchema: (
    spaceId: string,
    folderPath: string,
    hasSchema: boolean,
  ) => void;
  upsertTreeNode: (
    spaceId: string,
    parentPath: string,
    node: TreeNode,
  ) => void;
}

type SpaceFileEventKind = NonNullable<SpaceFileEventDto["kind"]>;

interface ApplySpaceFileEventInput {
  eventName: SpaceFileEventName;
  getStore: () => SpaceFileEventTreeStore;
  payload: SpaceFileEventDto;
  readEntry: (entryPath: string) => Promise<WatchedSpaceEntry>;
  repairTree: (parentPath?: string | null) => void;
  spaceId: string;
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function isSchemaPath(path: string): boolean {
  return basename(path) === "schema.yaml";
}

export function inferSpaceFileEventKind(
  payload: SpaceFileEventDto,
): SpaceFileEventKind {
  if (payload.kind) return payload.kind;
  if (isSchemaPath(payload.path)) return "schema";
  if (isMarkdownPath(payload.path)) return "document";
  if (payload.isDir) return "folder";
  return "unknown";
}

export function isSameSpaceFileEvent(
  payload: { space?: string },
  spacePath: string,
): boolean {
  return !payload.space || payload.space === spacePath;
}

export function affectsSpaceTreeOrMetadata(
  payload: SpaceFileEventDto,
): boolean {
  if (payload.affectsTree === false && payload.affectsMetadata === false) {
    return false;
  }
  return inferSpaceFileEventKind(payload) !== "unknown";
}

export function shouldApplySpaceFileEvent(
  payload: SpaceFileEventDto,
  spacePath: string,
): boolean {
  return (
    isSameSpaceFileEvent(payload, spacePath) &&
    affectsSpaceTreeOrMetadata(payload)
  );
}

export function watchedEntryToTreeNode(
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

export async function applySpaceFileEvent({
  eventName,
  getStore,
  payload,
  readEntry,
  repairTree,
  spaceId,
}: ApplySpaceFileEventInput): Promise<void> {
  const kind = inferSpaceFileEventKind(payload);
  if (kind === "unknown") {
    repairTree(payload.parentPath);
    return;
  }

  if (eventName === "file:created") {
    await applyCreatedSpaceFileEvent({
      getStore,
      payload,
      readEntry,
      spaceId,
      kind,
    });
    return;
  }

  if (eventName === "file:changed") {
    await applyChangedSpaceFileEvent({
      getStore,
      payload,
      readEntry,
      repairTree,
      spaceId,
      kind,
    });
    return;
  }

  applyDeletedSpaceFileEvent({
    getStore,
    payload,
    spaceId,
    kind,
  });
}

async function applyCreatedSpaceFileEvent({
  getStore,
  payload,
  readEntry,
  spaceId,
  kind,
}: Omit<ApplySpaceFileEventInput, "eventName" | "repairTree"> & {
  kind: SpaceFileEventKind;
}) {
  const store = getStore();
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    store.updateNodeSchema(spaceId, folderPathForSchema(path), true);
    return;
  }

  if (kind === "folder") {
    const parentPath = parentPathForTreeEvent(path, payload.parentPath);
    store.upsertTreeNode(spaceId, parentPath, {
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

  const entry = await readEntry(path);
  if (isReadmePath(path)) {
    if (!dirname(path)) {
      store.upsertTreeNode(spaceId, "", watchedEntryToTreeNode(path, entry, ""));
      return;
    }
    store.applyReadmeMeta(
      spaceId,
      path,
      entry.meta.title,
      entry.meta.icon,
      entry.meta.description,
    );
    return;
  }

  const parentPath = parentPathForTreeEvent(path, payload.parentPath);
  store.upsertTreeNode(
    spaceId,
    parentPath,
    watchedEntryToTreeNode(path, entry, parentPath),
  );
}

async function applyChangedSpaceFileEvent({
  getStore,
  payload,
  readEntry,
  repairTree,
  spaceId,
  kind,
}: Omit<ApplySpaceFileEventInput, "eventName"> & {
  kind: SpaceFileEventKind;
}) {
  const store = getStore();
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    store.updateNodeSchema(spaceId, folderPathForSchema(path), true);
    return;
  }

  if (kind === "folder") {
    repairTree(parentPathForTreeEvent(path, payload.parentPath));
    return;
  }

  const entry = await readEntry(path);
  if (isReadmePath(path) && dirname(path)) {
    store.applyReadmeMeta(
      spaceId,
      path,
      entry.meta.title,
      entry.meta.icon,
      entry.meta.description,
    );
    return;
  }

  store.updateNodeMeta(
    spaceId,
    path,
    entry.meta.title,
    entry.meta.icon,
    entry.meta.description,
  );
}

function applyDeletedSpaceFileEvent({
  getStore,
  payload,
  spaceId,
  kind,
}: Omit<ApplySpaceFileEventInput, "eventName" | "readEntry" | "repairTree"> & {
  kind: SpaceFileEventKind;
}) {
  const store = getStore();
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    store.updateNodeSchema(spaceId, folderPathForSchema(path), false);
    return;
  }

  if (kind === "document" && isReadmePath(path)) {
    store.removeReadmeMeta(spaceId, path);
    return;
  }

  if (kind === "document" || kind === "folder") {
    store.removeTreePath(spaceId, path);
  }
}
