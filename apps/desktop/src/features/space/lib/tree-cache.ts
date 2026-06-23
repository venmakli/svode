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

export function treeParentKeyForNode(node: TreeNode): string | null {
  return folderPathForNode(node);
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

function sameTreeNode(left: TreeNode, right: TreeNode): boolean {
  const leftPath = normalizeTreePath(left.path);
  const rightPath = normalizeTreePath(right.path);
  if (leftPath === rightPath) return true;
  const leftFolder = treeParentKeyForNode(left);
  const rightFolder = treeParentKeyForNode(right);
  return Boolean(leftFolder && rightFolder && leftFolder === rightFolder);
}

function mergeTreeNode(existing: TreeNode, incoming: TreeNode): TreeNode {
  const existingIsReadme = isReadmePath(existing.path);
  const incomingIsReadme = isReadmePath(incoming.path);
  const base = existingIsReadme && !incomingIsReadme ? existing : incoming;
  return {
    ...base,
    has_schema: existing.has_schema || incoming.has_schema,
    hasChildren: treeNodeHasChildren(existing) || treeNodeHasChildren(incoming),
    children: [],
  };
}

function upsertInList(children: TreeNode[], node: TreeNode): TreeNode[] {
  const direct = asDirectNode(node);
  const existing = children.find((child) => sameTreeNode(child, direct));
  if (!existing) return [...children, direct];
  return children.map((child) =>
    sameTreeNode(child, direct) ? mergeTreeNode(child, direct) : child,
  );
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

export function buildLoadedTree(
  childrenByParentPath: ChildrenByParentPath | undefined,
  expandedPaths: string[] | undefined,
  parentPath = ROOT_TREE_PARENT,
): TreeNode[] {
  const children = childrenByParentPath?.[treeParentKey(parentPath)] ?? [];
  const expanded = new Set(expandedPaths ?? []);

  return children.map((node) => {
    const childParent = treeParentKeyForNode(node);
    const shouldAttachChildren =
      childParent !== null && expanded.has(normalizeTreePath(node.path));
    return {
      ...node,
      children: shouldAttachChildren
        ? buildLoadedTree(childrenByParentPath, expandedPaths, childParent)
        : [],
    };
  });
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
  return Object.keys(childrenByParentPath).reduce<TreeParentCache>(
    (cache, key) => ({
      ...cache,
      [key]: { loadedAt, dirty: false },
    }),
    {},
  );
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

export function removeTreePathFromParents(
  childrenByParentPath: ChildrenByParentPath | undefined,
  path: string,
): ChildrenByParentPath | undefined {
  if (!childrenByParentPath) return childrenByParentPath;
  const normalized = normalizeTreePath(path);
  const folderPath = isReadmePath(normalized)
    ? dirname(normalized)
    : normalized;
  let changed = false;
  const next: ChildrenByParentPath = {};

  for (const [parent, children] of Object.entries(childrenByParentPath)) {
    if (
      parent === folderPath ||
      (folderPath && parent.startsWith(`${folderPath}/`))
    ) {
      changed = true;
      continue;
    }

    const filtered = children.filter((node) => {
      const nodePath = normalizeTreePath(node.path);
      const nodeFolder = treeParentKeyForNode(node);
      const remove =
        nodePath === normalized ||
        nodePath.startsWith(`${normalized}/`) ||
        nodeFolder === normalized ||
        (nodeFolder?.startsWith(`${normalized}/`) ?? false);
      if (remove) changed = true;
      return !remove;
    });
    next[parent] = filtered;
  }

  return changed ? next : childrenByParentPath;
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
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(childrenByParentPath).map(([parent, children]) => [
      parent,
      children.map((node) => {
        if (normalizeTreePath(node.path) !== normalized) return node;
        changed = true;
        return {
          ...node,
          title: meta.title,
          icon: meta.icon,
          ...(meta.description !== undefined
            ? { description: meta.description }
            : {}),
        };
      }),
    ]),
  );
  return changed ? next : childrenByParentPath;
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
      const next = children.map((node) => {
        if (treeParentKeyForNode(node) !== folderPath) return node;
        found = true;
        return {
          ...node,
          name: basename(folderPath),
          path: normalized,
          title: meta.title,
          icon: meta.icon,
          description: meta.description,
          hasChildren:
            treeNodeHasChildren(node) ||
            Boolean(childrenByParentPath[folderPath]?.length),
        };
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
      children.map((node) =>
        treeParentKeyForNode(node) === folderPath
          ? {
              ...node,
              name: basename(folderPath),
              path: folderPath,
              title: basename(folderPath),
              icon: null,
              description: null,
              hasChildren:
                treeNodeHasChildren(node) ||
                Boolean(childrenByParentPath[folderPath]?.length),
            }
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
    const next = children.map((node) => {
      if (treeParentKeyForNode(node) !== normalized) return node;
      found = true;
      return {
        ...node,
        has_schema: hasSchema,
        hasChildren:
          treeNodeHasChildren(node) ||
          Boolean(childrenByParentPath[normalized]?.length),
      };
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
