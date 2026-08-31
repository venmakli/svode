import type { TreeNode } from "../model/types";
import type {
  SpaceFileEvent,
  SpaceFileEventKind,
  SpaceFileEventName,
  WatchedSpacePage,
} from "../model/space-watch-events";
import {
  basename,
  dirname,
  folderPathForSchema,
  isReadmePath,
  normalizeTreePath,
  parentPathForTreeEvent,
  treeRowParentPath,
} from "./tree-patches";

export const SPACE_FILE_EVENT_NAMES: SpaceFileEventName[] = [
  "file:created",
  "file:changed",
  "file:deleted",
];
export const SPACE_FILE_EVENT_BATCH_MS = 50;

export type QueuedSpaceFileEvent = {
  eventName: SpaceFileEventName;
  payload: SpaceFileEvent;
};

export interface SpaceFileEventTreeStore {
  patchSpaceSchemaCapability: (spaceId: string, hasSchema: boolean) => void;
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
  upsertTreeNode: (spaceId: string, parentPath: string, node: TreeNode) => void;
}

interface ApplySpaceFileEventInput {
  eventName: SpaceFileEventName;
  getStore: () => SpaceFileEventTreeStore;
  payload: SpaceFileEvent;
  readPage: (pagePath: string) => Promise<WatchedSpacePage>;
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
  payload: SpaceFileEvent,
): SpaceFileEventKind {
  if (payload.kind) return payload.kind;
  if (isSchemaPath(payload.path)) return "schema";
  if (isMarkdownPath(payload.path)) return "page";
  if (payload.isDir) return "folder";
  return "unknown";
}

export function isSameSpaceFileEvent(
  payload: { space?: string },
  spacePath: string,
): boolean {
  return !payload.space || payload.space === spacePath;
}

export function affectsSpaceTreeOrMetadata(payload: SpaceFileEvent): boolean {
  if (payload.affectsTree === false && payload.affectsMetadata === false) {
    return false;
  }
  return inferSpaceFileEventKind(payload) !== "unknown";
}

export function shouldApplySpaceFileEvent(
  payload: SpaceFileEvent,
  spacePath: string,
): boolean {
  return (
    isSameSpaceFileEvent(payload, spacePath) &&
    affectsSpaceTreeOrMetadata(payload)
  );
}

export function repairParentPathForSpaceFileEvent(
  payload: SpaceFileEvent,
): string | null {
  const path = normalizeTreePath(payload.path);
  const kind = inferSpaceFileEventKind(payload);

  if (kind === "schema") {
    return treeRowParentPath(folderPathForSchema(path));
  }

  return treeRowParentPath(path) ?? normalizeTreePath(payload.parentPath);
}

export function watchedPageToTreeNode(
  pagePath: string,
  page: WatchedSpacePage,
  parentPath?: string | null,
): TreeNode {
  return {
    name: basename(pagePath),
    path: normalizeTreePath(pagePath),
    title: page.meta.title,
    icon: page.meta.icon,
    description: page.meta.description,
    has_changes: false,
    has_schema: false,
    parent: parentPath ?? dirname(pagePath),
    kind: "page",
    source_shape: "file",
    hasChildren: false,
    children: [],
  };
}

export async function applySpaceFileEvent({
  eventName,
  getStore,
  payload,
  readPage,
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
      readPage,
      spaceId,
      kind,
    });
    repairTree(repairParentPathForSpaceFileEvent(payload));
    return;
  }

  if (eventName === "file:changed") {
    await applyChangedSpaceFileEvent({
      getStore,
      payload,
      readPage,
      repairTree,
      spaceId,
      kind,
    });
    repairTree(repairParentPathForSpaceFileEvent(payload));
    return;
  }

  applyDeletedSpaceFileEvent({
    getStore,
    payload,
    spaceId,
    kind,
  });
  repairTree(repairParentPathForSpaceFileEvent(payload));
}

function updateSchemaCapability(
  store: SpaceFileEventTreeStore,
  spaceId: string,
  schemaPath: string,
  hasSchema: boolean,
) {
  const ownerPath = folderPathForSchema(schemaPath);
  if (!ownerPath) {
    store.patchSpaceSchemaCapability(spaceId, hasSchema);
    return;
  }
  store.updateNodeSchema(spaceId, ownerPath, hasSchema);
}

async function applyCreatedSpaceFileEvent({
  getStore,
  payload,
  readPage,
  spaceId,
  kind,
}: Omit<ApplySpaceFileEventInput, "eventName" | "repairTree"> & {
  kind: SpaceFileEventKind;
}) {
  const store = getStore();
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    updateSchemaCapability(store, spaceId, path, true);
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

  const page = await readPage(path);
  if (isReadmePath(path)) {
    if (!dirname(path)) {
      store.upsertTreeNode(
        spaceId,
        "",
        watchedPageToTreeNode(path, page, ""),
      );
      return;
    }
    store.applyReadmeMeta(
      spaceId,
      path,
      page.meta.title,
      page.meta.icon,
      page.meta.description,
    );
    return;
  }

  const parentPath = parentPathForTreeEvent(path, payload.parentPath);
  store.upsertTreeNode(
    spaceId,
    parentPath,
    watchedPageToTreeNode(path, page, parentPath),
  );
}

async function applyChangedSpaceFileEvent({
  getStore,
  payload,
  readPage,
  spaceId,
  kind,
}: Omit<ApplySpaceFileEventInput, "eventName"> & {
  kind: SpaceFileEventKind;
}) {
  const store = getStore();
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    updateSchemaCapability(store, spaceId, path, true);
    return;
  }

  if (kind === "folder") {
    return;
  }

  const page = await readPage(path);
  if (isReadmePath(path) && dirname(path)) {
    store.applyReadmeMeta(
      spaceId,
      path,
      page.meta.title,
      page.meta.icon,
      page.meta.description,
    );
    return;
  }

  store.updateNodeMeta(
    spaceId,
    path,
    page.meta.title,
    page.meta.icon,
    page.meta.description,
  );
}

function applyDeletedSpaceFileEvent({
  getStore,
  payload,
  spaceId,
  kind,
}: Omit<ApplySpaceFileEventInput, "eventName" | "readPage" | "repairTree"> & {
  kind: SpaceFileEventKind;
}) {
  const store = getStore();
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    updateSchemaCapability(store, spaceId, path, false);
    return;
  }

  if (kind === "page" && isReadmePath(path)) {
    store.removeReadmeMeta(spaceId, path);
    return;
  }

  if (kind === "page" || kind === "folder") {
    store.removeTreePath(spaceId, path);
  }
}
