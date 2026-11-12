import type { TreeNode } from "../model/types";
import {
  ROOT_TREE_PARENT,
  treeParentKey,
  type ChildrenByParentPath,
} from "./tree-cache";
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
  patchSpaceAppCapability: (spaceId: string, hasApp: boolean) => void;
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
  updateNodeApp: (spaceId: string, folderPath: string, hasApp: boolean) => void;
  upsertTreeNode: (spaceId: string, parentPath: string, node: TreeNode) => void;
}

export interface SpaceFileEventBatchStore extends SpaceFileEventTreeStore {
  childrenByParentPath: Record<string, ChildrenByParentPath>;
  batchTreeUpdates: (run: () => void) => void;
  markTreeParentDirty: (spaceId: string, parentPath?: string | null) => void;
  loadTreeChildren: (
    spaceId: string,
    parentPath?: string | null,
    options?: { force?: boolean },
  ) => Promise<void>;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
}

export type ResolvedSpaceFileEvent = QueuedSpaceFileEvent & {
  spaceId: string;
  spacePath: string;
};

type SpaceFileEventPatch = (store: SpaceFileEventTreeStore) => void;

interface PrepareSpaceFileEventInput {
  eventName: SpaceFileEventName;
  payload: SpaceFileEvent;
  readPage: (pagePath: string) => Promise<WatchedSpacePage>;
  repairTree: (parentPath?: string | null) => void;
  spaceId: string;
  /**
   * Whether the cached list of this parent takes the Page row from the event.
   * False when the caller lists the parent again or does not cache it: the
   * Page head is then not read.
   */
  patchesParent?: (parentPath: string) => boolean;
}

interface ApplySpaceFileEventInput extends PrepareSpaceFileEventInput {
  getStore: () => SpaceFileEventTreeStore;
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function isSchemaPath(path: string): boolean {
  return basename(path) === "schema.yaml";
}

function isAppManifestPath(path: string): boolean {
  return basename(path) === "app.yaml";
}

export function inferSpaceFileEventKind(
  payload: SpaceFileEvent,
): SpaceFileEventKind {
  if (payload.kind) return payload.kind;
  if (isSchemaPath(payload.path)) return "schema";
  if (isAppManifestPath(payload.path)) return "app";
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

  if (kind === "schema" || kind === "app") {
    return treeRowParentPath(folderPathForSchema(path));
  }

  return treeRowParentPath(path) ?? normalizeTreePath(payload.parentPath);
}

export function repairPathsForSpaceFileEvent(
  payload: SpaceFileEvent,
): string[] {
  const parent = repairParentPathForSpaceFileEvent(payload) ?? "";
  const paths = new Set([parent]);
  // Reload the row carrying this parent's child hint as well as its children.
  if (parent) paths.add(treeRowParentPath(parent) ?? "");
  const kind = inferSpaceFileEventKind(payload);
  if (kind === "app" || kind === "schema" || isReadmePath(payload.path)) {
    paths.add(dirname(normalizeTreePath(payload.path)));
  }
  return [...paths];
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
  getStore,
  ...input
}: ApplySpaceFileEventInput): Promise<void> {
  const apply = await prepareSpaceFileEvent(input);
  apply(getStore());
}

/**
 * Reads what a file event needs and returns its synchronous store patch,
 * which also queues the tree repair of the event.
 */
export async function prepareSpaceFileEvent({
  eventName,
  payload,
  readPage,
  repairTree,
  spaceId,
  patchesParent = () => true,
}: PrepareSpaceFileEventInput): Promise<SpaceFileEventPatch> {
  const kind = inferSpaceFileEventKind(payload);
  if (kind === "unknown") {
    return () => repairTree(payload.parentPath);
  }

  const input = { payload, readPage, spaceId, kind, patchesParent };
  const patch =
    eventName === "file:created"
      ? await createdSpaceFileEventPatch(input)
      : eventName === "file:changed"
        ? await changedSpaceFileEventPatch(input)
        : deletedSpaceFileEventPatch(input);
  const repairParent = repairParentPathForSpaceFileEvent(payload);
  return (store) => {
    patch(store);
    repairTree(repairParent);
  };
}

/**
 * Applies one watcher batch: Page heads are read only for rows no relisting
 * covers, all store patches and dirty marks go in one store update, and each
 * affected cached parent is listed again once.
 */
export async function applySpaceFileEventBatch({
  events,
  getStore,
  readPage,
}: {
  events: ResolvedSpaceFileEvent[];
  getStore: () => SpaceFileEventBatchStore;
  readPage: (spacePath: string, pagePath: string) => Promise<WatchedSpacePage>;
}): Promise<void> {
  const cached = getStore().childrenByParentPath;
  const dirty = new Map<string, Set<string>>();
  const relisted = new Map<string, Set<string>>();
  const add = (
    map: Map<string, Set<string>>,
    spaceId: string,
    parent: string,
  ) => {
    const parents = map.get(spaceId) ?? new Set<string>();
    parents.add(parent);
    map.set(spaceId, parents);
  };
  const isCached = (spaceId: string, parent: string) =>
    parent === ROOT_TREE_PARENT || Object.hasOwn(cached[spaceId] ?? {}, parent);
  const queueRepair = (spaceId: string, parentPath?: string | null) => {
    const parent = treeParentKey(parentPath);
    add(dirty, spaceId, parent);
    if (isCached(spaceId, parent)) add(relisted, spaceId, parent);
  };

  const prepared: Array<{
    spaceId: string;
    payload: SpaceFileEvent;
    apply: SpaceFileEventPatch;
  }> = [];
  for (const { eventName, payload, spaceId, spacePath } of events) {
    if (!shouldApplySpaceFileEvent(payload, spacePath)) continue;
    if (payload.affectsTree) {
      for (const path of repairPathsForSpaceFileEvent(payload)) {
        queueRepair(spaceId, path);
      }
    }
    queueRepair(spaceId, repairParentPathForSpaceFileEvent(payload));
    try {
      const apply = await prepareSpaceFileEvent({
        eventName,
        payload,
        readPage: (pagePath) => readPage(spacePath, pagePath),
        repairTree: (parentPath) => queueRepair(spaceId, parentPath),
        spaceId,
        patchesParent: (parentPath) => {
          const parent = treeParentKey(parentPath);
          if (relisted.get(spaceId)?.has(parent)) return false;
          return !cached[spaceId] || isCached(spaceId, parent);
        },
      });
      prepared.push({ spaceId, payload, apply });
    } catch (error) {
      console.warn("Failed to apply space tree event:", error);
      queueRepair(
        spaceId,
        repairParentPathForSpaceFileEvent(payload) ?? payload.parentPath,
      );
    }
  }

  const store = getStore();
  store.batchTreeUpdates(() => {
    for (const { spaceId, payload, apply } of prepared) {
      try {
        apply(store);
      } catch (error) {
        console.warn("Failed to apply space tree event:", error);
        queueRepair(
          spaceId,
          repairParentPathForSpaceFileEvent(payload) ?? payload.parentPath,
        );
      }
    }
    for (const [spaceId, parents] of dirty) {
      for (const parent of parents) store.markTreeParentDirty(spaceId, parent);
    }
  });

  for (const spaceId of dirty.keys()) {
    const current = getStore();
    for (const parent of relisted.get(spaceId) ?? []) {
      await current.loadTreeChildren(spaceId, parent, { force: true });
    }
    await current.ensureTreeLoaded(spaceId);
  }
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

function updateAppCapability(
  store: SpaceFileEventTreeStore,
  spaceId: string,
  manifestPath: string,
  hasApp: boolean,
) {
  const ownerPath = folderPathForSchema(manifestPath);
  if (!ownerPath) {
    store.patchSpaceAppCapability(spaceId, hasApp);
    return;
  }
  store.updateNodeApp(spaceId, ownerPath, hasApp);
}

type SpaceFileEventPatchInput = Pick<
  PrepareSpaceFileEventInput,
  "payload" | "readPage" | "spaceId"
> & {
  kind: SpaceFileEventKind;
  patchesParent: (parentPath: string) => boolean;
};

const NO_PATCH: SpaceFileEventPatch = () => undefined;

async function createdSpaceFileEventPatch({
  payload,
  readPage,
  spaceId,
  kind,
  patchesParent,
}: SpaceFileEventPatchInput): Promise<SpaceFileEventPatch> {
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    return (store) => updateSchemaCapability(store, spaceId, path, true);
  }

  if (kind === "app") {
    return (store) => updateAppCapability(store, spaceId, path, true);
  }

  if (kind === "folder") {
    const parentPath = parentPathForTreeEvent(path, payload.parentPath);
    return (store) =>
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
  }

  if (isReadmePath(path)) {
    if (!patchesParent(treeRowParentPath(path) ?? "")) return NO_PATCH;
    const page = await readPage(path);
    if (!dirname(path)) {
      return (store) =>
        store.upsertTreeNode(
          spaceId,
          "",
          watchedPageToTreeNode(path, page, ""),
        );
    }
    return (store) =>
      store.applyReadmeMeta(
        spaceId,
        path,
        page.meta.title,
        page.meta.icon,
        page.meta.description,
      );
  }

  const parentPath = parentPathForTreeEvent(path, payload.parentPath);
  if (!patchesParent(parentPath)) return NO_PATCH;
  const page = await readPage(path);
  return (store) =>
    store.upsertTreeNode(
      spaceId,
      parentPath,
      watchedPageToTreeNode(path, page, parentPath),
    );
}

async function changedSpaceFileEventPatch({
  payload,
  readPage,
  spaceId,
  kind,
  patchesParent,
}: SpaceFileEventPatchInput): Promise<SpaceFileEventPatch> {
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    return (store) => updateSchemaCapability(store, spaceId, path, true);
  }

  if (kind === "app" || kind === "folder") return NO_PATCH;

  if (!patchesParent(treeRowParentPath(path) ?? "")) return NO_PATCH;
  const page = await readPage(path);
  if (isReadmePath(path) && dirname(path)) {
    return (store) =>
      store.applyReadmeMeta(
        spaceId,
        path,
        page.meta.title,
        page.meta.icon,
        page.meta.description,
      );
  }

  return (store) =>
    store.updateNodeMeta(
      spaceId,
      path,
      page.meta.title,
      page.meta.icon,
      page.meta.description,
    );
}

function deletedSpaceFileEventPatch({
  payload,
  spaceId,
  kind,
}: SpaceFileEventPatchInput): SpaceFileEventPatch {
  const path = normalizeTreePath(payload.path);

  if (kind === "schema") {
    return (store) => updateSchemaCapability(store, spaceId, path, false);
  }

  if (kind === "app") {
    return (store) => updateAppCapability(store, spaceId, path, false);
  }

  if (kind === "page" && isReadmePath(path)) {
    return (store) => store.removeReadmeMeta(spaceId, path);
  }

  if (kind === "page" || kind === "folder") {
    return (store) => store.removeTreePath(spaceId, path);
  }

  return NO_PATCH;
}
