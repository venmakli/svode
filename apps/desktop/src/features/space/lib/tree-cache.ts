import type { TreeNode } from "../model/types";
import {
  basename,
  dirname,
  folderPathForNode,
  isReadmePath,
  normalizeTreePath,
} from "./tree-patches";

export const ROOT_TREE_PARENT = "";

export interface TreeParentCacheEntry {
  loadedAt: number;
  dirty: boolean;
}

export type ChildrenByParentPath = Record<string, TreeNode[]>;
export type TreeParentCache = Record<string, TreeParentCacheEntry>;

export function treeParentKey(path: string | null | undefined): string {
  const normalized = normalizeTreePath(path);
  if (!normalized) return ROOT_TREE_PARENT;
  if (isReadmePath(normalized)) return dirname(normalized);
  return normalized;
}

interface TreeNodeKeys {
  path: string;
  folder: string | null;
}

// Tree nodes are immutable, so their path keys are computed once per object.
const nodeKeys = new WeakMap<TreeNode, TreeNodeKeys>();
// A visible node of `fileTrees` points to the cached node it was built from.
const visibleSource = new WeakMap<TreeNode, TreeNode>();

function treeNodeKeys(node: TreeNode): TreeNodeKeys {
  let keys = nodeKeys.get(node);
  if (!keys) {
    keys = {
      path: normalizeTreePath(node.path),
      folder: folderPathForNode(node),
    };
    nodeKeys.set(node, keys);
  }
  return keys;
}

export function treeParentKeyForNode(node: TreeNode): string | null {
  return treeNodeKeys(node).folder;
}

export function treeNodeHasChildren(node: TreeNode): boolean {
  return Boolean(node.hasChildren ?? node.has_children ?? node.children.length);
}

function asDirectNode(node: TreeNode): TreeNode {
  return {
    ...node,
    hasChildren: treeNodeHasChildren(node),
    children: [],
  };
}

function sameIdentity(left: TreeNodeKeys, right: TreeNodeKeys): boolean {
  if (left.path === right.path) return true;
  return Boolean(left.folder && right.folder && left.folder === right.folder);
}

function sameNameConflict(
  left: TreeNode["name_conflict"],
  right: TreeNode["name_conflict"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.parentPath === right.parentPath &&
    left.conflicts.length === right.conflicts.length &&
    left.conflicts.every(
      (conflict, index) =>
        conflict.path === right.conflicts[index]?.path &&
        conflict.title === right.conflicts[index]?.title,
    )
  );
}

/** Same fields of a cached node, whose children are always empty. */
function sameDirectNode(left: TreeNode, right: TreeNode): boolean {
  if (left === right) return true;
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftFields);
  if (keys.length !== Object.keys(rightFields).length) return false;
  return keys.every((key) => {
    if (key === "children") return true;
    if (leftFields[key] === rightFields[key]) return true;
    return (
      key === "name_conflict" &&
      sameNameConflict(left.name_conflict, right.name_conflict)
    );
  });
}

function withFields(node: TreeNode, fields: Partial<TreeNode>): TreeNode {
  const current = node as unknown as Record<string, unknown>;
  const changed = Object.entries(fields).some(
    ([key, value]) => current[key] !== value,
  );
  return changed ? { ...node, ...fields } : node;
}

function mapNodes(
  children: TreeNode[],
  mapNode: (node: TreeNode) => TreeNode,
): TreeNode[] {
  let next: TreeNode[] | null = null;
  children.forEach((child, index) => {
    const mapped = mapNode(child);
    if (mapped === child) return;
    next ??= children.slice();
    next[index] = mapped;
  });
  return next ?? children;
}

function mergeTreeNode(existing: TreeNode, incoming: TreeNode): TreeNode {
  const existingIsReadme = isReadmePath(existing.path);
  const incomingIsReadme = isReadmePath(incoming.path);
  const base = existingIsReadme && !incomingIsReadme ? existing : incoming;
  const merged = {
    ...base,
    has_schema: existing.has_schema || incoming.has_schema,
    has_app: existing.has_app || incoming.has_app,
    hasChildren: treeNodeHasChildren(existing) || treeNodeHasChildren(incoming),
    children: [],
  };
  return sameDirectNode(merged, existing) ? existing : merged;
}

function upsertInList(children: TreeNode[], node: TreeNode): TreeNode[] {
  const direct = asDirectNode(node);
  const keys = treeNodeKeys(direct);
  let found = false;
  const next = mapNodes(children, (child) => {
    if (!sameIdentity(treeNodeKeys(child), keys)) return child;
    found = true;
    return mergeTreeNode(child, direct);
  });
  return found ? next : [...children, direct];
}

function mapParentChildren(
  childrenByParentPath: ChildrenByParentPath,
  parentPath: string,
  mapChildren: (children: TreeNode[]) => TreeNode[],
): ChildrenByParentPath {
  const key = treeParentKey(parentPath);
  const current = childrenByParentPath[key];
  if (!current) return childrenByParentPath;
  const next = mapChildren(current);
  if (next === current) return childrenByParentPath;
  return { ...childrenByParentPath, [key]: next };
}

/**
 * Cached children of a parent from a fresh listing. A node whose fields did
 * not change keeps its object, and an unchanged listing keeps the list.
 */
export function reconcileTreeChildren(
  previous: TreeNode[] | undefined,
  incoming: TreeNode[],
): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  for (const node of previous ?? []) byPath.set(treeNodeKeys(node).path, node);
  let reused = previous?.length === incoming.length;
  const next = incoming.map((node, index) => {
    const existing = byPath.get(normalizeTreePath(node.path));
    const kept =
      existing && sameDirectNode(existing, node)
        ? existing
        : { ...node, children: [] };
    if (kept !== previous?.[index]) reused = false;
    return kept;
  });
  return reused && previous ? previous : next;
}

function buildVisibleLevel(
  childrenByParentPath: ChildrenByParentPath | undefined,
  expanded: Set<string>,
  parentKey: string,
  previous: TreeNode[] | undefined,
): TreeNode[] {
  const children = childrenByParentPath?.[parentKey] ?? [];
  let previousBySource: Map<TreeNode, TreeNode> | null = null;
  const previousFor = (source: TreeNode, index: number) => {
    const atIndex = previous?.[index];
    if (!previous || (atIndex && visibleSource.get(atIndex) === source)) {
      return atIndex;
    }
    previousBySource ??= new Map(
      previous.map((visible) => [
        visibleSource.get(visible) ?? visible,
        visible,
      ]),
    );
    return previousBySource.get(source);
  };

  let reused = previous?.length === children.length;
  const level = children.map((source, index) => {
    const prior = previousFor(source, index);
    const keys = treeNodeKeys(source);
    const childLevel =
      keys.folder !== null && expanded.has(keys.path)
        ? buildVisibleLevel(
            childrenByParentPath,
            expanded,
            keys.folder,
            prior?.children,
          )
        : [];
    let visible: TreeNode;
    if (
      prior &&
      (prior.children === childLevel ||
        (prior.children.length === 0 && childLevel.length === 0))
    ) {
      visible = prior;
    } else {
      visible = { ...source, children: childLevel };
      visibleSource.set(visible, source);
    }
    if (visible !== previous?.[index]) reused = false;
    return visible;
  });
  return reused && previous ? previous : level;
}

export function buildLoadedTree(
  childrenByParentPath: ChildrenByParentPath | undefined,
  expandedPaths: string[] | undefined,
  parentPath = ROOT_TREE_PARENT,
): TreeNode[] {
  return buildVisibleLevel(
    childrenByParentPath,
    new Set(expandedPaths ?? []),
    treeParentKey(parentPath),
    undefined,
  );
}

/**
 * Visible tree built over the previous one: nodes and subtrees that did not
 * change keep their objects, and an unchanged tree keeps its array.
 */
export function rebuildLoadedTree(
  previous: TreeNode[] | undefined,
  childrenByParentPath: ChildrenByParentPath | undefined,
  expandedPaths: string[] | undefined,
): TreeNode[] {
  return buildVisibleLevel(
    childrenByParentPath,
    new Set(expandedPaths ?? []),
    ROOT_TREE_PARENT,
    previous,
  );
}

export function flattenChildrenByParentPath(
  nodes: TreeNode[],
  parentPath = ROOT_TREE_PARENT,
  result: ChildrenByParentPath = {},
): ChildrenByParentPath {
  const key = treeParentKey(parentPath);
  result[key] = nodes.map(asDirectNode);
  for (const node of nodes) {
    const childParent = treeParentKeyForNode(node);
    if (childParent && node.children.length > 0) {
      flattenChildrenByParentPath(node.children, childParent, result);
    }
  }
  return result;
}

export function loadedParentCache(
  childrenByParentPath: ChildrenByParentPath,
  loadedAt: number,
): TreeParentCache {
  const cache: TreeParentCache = {};
  for (const key of Object.keys(childrenByParentPath)) {
    cache[key] = { loadedAt, dirty: false };
  }
  return cache;
}

export function upsertTreeNodeInParent(
  childrenByParentPath: ChildrenByParentPath | undefined,
  parentPath: string,
  node: TreeNode,
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  return mapParentChildren(childrenByParentPath, parentPath, (children) =>
    upsertInList(children, node),
  );
}

/** Cached parent whose list holds the row of `path`. */
function rowParentKey(normalizedPath: string): string {
  const rowPath = isReadmePath(normalizedPath)
    ? dirname(normalizedPath)
    : normalizedPath;
  return dirname(rowPath);
}

export function removeTreePathFromParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  path: string,
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(path);
  const folderPath = isReadmePath(normalized)
    ? dirname(normalized)
    : normalized;
  let next: ChildrenByParentPath | null = null;

  for (const parent of Object.keys(childrenByParentPath)) {
    if (
      parent === folderPath ||
      (folderPath && parent.startsWith(`${folderPath}/`))
    ) {
      next ??= { ...childrenByParentPath };
      delete next[parent];
    }
  }

  const under = (key: string | null) =>
    key !== null && (key === normalized || key.startsWith(`${normalized}/`));
  const rowParent = rowParentKey(normalized);
  const children = (next ?? childrenByParentPath)[rowParent];
  if (children) {
    const filtered = children.filter((node) => {
      const keys = treeNodeKeys(node);
      return !under(keys.path) && !under(keys.folder);
    });
    if (filtered.length !== children.length) {
      next ??= { ...childrenByParentPath };
      next[rowParent] = filtered;
    }
  }

  return next ?? childrenByParentPath;
}

export function updateTreeNodeMetaInParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  path: string,
  meta: {
    title: string;
    icon: string | null;
    description?: string | null;
  },
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(path);
  return mapParentChildren(
    childrenByParentPath,
    rowParentKey(normalized),
    (children) =>
      mapNodes(children, (node) =>
        treeNodeKeys(node).path === normalized
          ? withFields(node, {
              title: meta.title,
              icon: meta.icon,
              ...(meta.description !== undefined
                ? { description: meta.description }
                : {}),
            })
          : node,
      ),
  );
}

export function applyReadmeMetaToParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  readmePath: string,
  meta: {
    title: string;
    icon: string | null;
    description?: string | null;
  },
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(readmePath);
  const folderPath = dirname(normalized);
  if (!folderPath) {
    return updateTreeNodeMetaInParents(childrenByParentPath, normalized, meta);
  }

  return mapParentChildren(
    childrenByParentPath,
    dirname(folderPath),
    (children) => {
      let found = false;
      const next = mapNodes(children, (node) => {
        if (treeParentKeyForNode(node) !== folderPath) return node;
        found = true;
        return withFields(node, {
          name: basename(folderPath),
          path: normalized,
          title: meta.title,
          icon: meta.icon,
          description: meta.description,
          hasChildren:
            treeNodeHasChildren(node) ||
            Boolean(childrenByParentPath[folderPath]?.length),
        });
      });
      if (found) return next;
      return [
        ...next,
        {
          name: basename(folderPath),
          path: normalized,
          title: meta.title,
          icon: meta.icon,
          description: meta.description,
          has_changes: false,
          has_schema: false,
          hasChildren: Boolean(childrenByParentPath[folderPath]?.length),
          parent: dirname(folderPath),
          kind: "folder",
          children: [],
        },
      ];
    },
  );
}

export function removeReadmeMetaFromParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  readmePath: string,
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(readmePath);
  const folderPath = dirname(normalized);
  if (!folderPath)
    return removeTreePathFromParents(childrenByParentPath, normalized);

  return mapParentChildren(
    childrenByParentPath,
    dirname(folderPath),
    (children) =>
      mapNodes(children, (node) =>
        treeParentKeyForNode(node) === folderPath
          ? withFields(node, {
              name: basename(folderPath),
              path: folderPath,
              title: basename(folderPath),
              icon: null,
              description: null,
              hasChildren:
                treeNodeHasChildren(node) ||
                Boolean(childrenByParentPath[folderPath]?.length),
            })
          : node,
      ),
  );
}

export function updateTreeSchemaInParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  folderPath: string,
  hasSchema: boolean,
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(folderPath);
  const parentPath = dirname(normalized);

  return mapParentChildren(childrenByParentPath, parentPath, (children) => {
    let found = false;
    const next = mapNodes(children, (node) => {
      if (treeParentKeyForNode(node) !== normalized) return node;
      found = true;
      return withFields(node, {
        has_schema: hasSchema,
        hasChildren:
          treeNodeHasChildren(node) ||
          Boolean(childrenByParentPath[normalized]?.length),
      });
    });
    if (found || !hasSchema || !normalized) return next;
    return [
      ...next,
      {
        name: basename(normalized),
        path: normalized,
        title: basename(normalized),
        icon: null,
        description: null,
        has_changes: false,
        has_schema: true,
        hasChildren: Boolean(childrenByParentPath[normalized]?.length),
        parent: parentPath,
        kind: "collection",
        children: [],
      },
    ];
  });
}

export function updateTreeAppInParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  folderPath: string,
  hasApp: boolean,
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(folderPath);
  const parentPath = dirname(normalized);

  return mapParentChildren(childrenByParentPath, parentPath, (children) => {
    let found = false;
    const next = mapNodes(children, (node) => {
      if (treeParentKeyForNode(node) !== normalized) return node;
      found = true;
      return withFields(node, {
        has_app: hasApp,
        hasChildren:
          treeNodeHasChildren(node) ||
          Boolean(childrenByParentPath[normalized]?.length),
      });
    });
    if (found || !hasApp || !normalized) return next;
    return [
      ...next,
      {
        name: basename(normalized),
        path: normalized,
        title: basename(normalized),
        icon: null,
        description: null,
        has_changes: false,
        has_schema: false,
        has_app: true,
        hasChildren: Boolean(childrenByParentPath[normalized]?.length),
        parent: parentPath,
        kind: "app" as const,
        children: [],
      },
    ];
  });
}
