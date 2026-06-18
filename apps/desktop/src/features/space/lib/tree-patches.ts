import type { TreeNode } from "@/features/entry";

export interface TreeNodePatchMeta {
  title: string;
  icon: string | null;
  description?: string | null;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export function normalizeTreePath(path: string | null | undefined): string {
  return trimSlashes((path ?? "").replaceAll("\\", "/"));
}

export function basename(path: string): string {
  const normalized = normalizeTreePath(path);
  if (!normalized) return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
  const normalized = normalizeTreePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

export function isReadmePath(path: string): boolean {
  return basename(path).toLowerCase() === "readme.md";
}

function isReadmeNodePath(path: string): boolean {
  return /(^|\/)readme\.md$/i.test(normalizeTreePath(path));
}

export function folderPathForNode(node: TreeNode): string | null {
  const path = normalizeTreePath(node.path);
  if (!path) return null;
  if (!path.endsWith(".md")) return path;
  if (isReadmeNodePath(path)) return dirname(path);
  if (node.children.length > 0 || node.has_schema) return dirname(path);
  return null;
}

export function folderPathForSchema(schemaPath: string): string {
  return dirname(schemaPath);
}

export function parentPathForTreeEvent(path: string, explicit?: string | null) {
  return normalizeTreePath(explicit ?? dirname(path));
}

function replaceChild(
  nodes: TreeNode[],
  predicate: (node: TreeNode) => boolean,
  mapNode: (node: TreeNode) => TreeNode,
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (predicate(node)) {
      changed = true;
      return mapNode(node);
    }
    if (node.children.length === 0) return node;
    const children = replaceChild(node.children, predicate, mapNode);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? next : nodes;
}

function sameNodeIdentity(left: TreeNode, right: TreeNode): boolean {
  if (normalizeTreePath(left.path) === normalizeTreePath(right.path)) {
    return true;
  }
  const leftFolder = folderPathForNode(left);
  const rightFolder = folderPathForNode(right);
  return Boolean(leftFolder && rightFolder && leftFolder === rightFolder);
}

function mergeIncomingNode(existing: TreeNode, incoming: TreeNode): TreeNode {
  const existingIsReadme = isReadmeNodePath(existing.path);
  const incomingIsReadme = isReadmeNodePath(incoming.path);
  const base = existingIsReadme && !incomingIsReadme ? existing : incoming;

  return {
    ...base,
    has_schema: existing.has_schema || incoming.has_schema,
    children:
      existing.children.length > 0 ? existing.children : incoming.children,
  };
}

function insertIntoParent(
  nodes: TreeNode[],
  parentPath: string,
  node: TreeNode,
): TreeNode[] {
  if (!parentPath) {
    const existing = nodes.find((item) => sameNodeIdentity(item, node));
    if (existing) {
      return nodes.map((item) =>
        sameNodeIdentity(item, node) ? mergeIncomingNode(item, node) : item,
      );
    }
    return [...nodes, node];
  }

  return replaceChild(
    nodes,
    (item) => folderPathForNode(item) === parentPath,
    (item) => {
      const existing = item.children.find((child) =>
        sameNodeIdentity(child, node),
      );
      const children = existing
        ? item.children.map((child) =>
            sameNodeIdentity(child, node)
              ? mergeIncomingNode(child, node)
              : child,
          )
        : [...item.children, node];
      return { ...item, children };
    },
  );
}

export function upsertTreeNode(
  nodes: TreeNode[],
  parentPath: string,
  node: TreeNode,
): TreeNode[] {
  const normalizedParent = normalizeTreePath(parentPath);
  return insertIntoParent(nodes, normalizedParent, {
    ...node,
    path: normalizeTreePath(node.path),
  });
}

export function removeTreePath(nodes: TreeNode[], path: string): TreeNode[] {
  const normalized = normalizeTreePath(path);
  let changed = false;
  const next = nodes
    .filter((node) => {
      const nodePath = normalizeTreePath(node.path);
      const nodeFolderPath = folderPathForNode(node);
      const shouldRemove =
        nodePath === normalized ||
        nodePath.startsWith(`${normalized}/`) ||
        nodeFolderPath === normalized ||
        (nodeFolderPath?.startsWith(`${normalized}/`) ?? false);
      if (shouldRemove) changed = true;
      return !shouldRemove;
    })
    .map((node) => {
      if (node.children.length === 0) return node;
      const children = removeTreePath(node.children, normalized);
      if (children === node.children) return node;
      changed = true;
      return { ...node, children };
    });
  return changed ? next : nodes;
}

export function updateTreeNodeMeta(
  nodes: TreeNode[],
  path: string,
  meta: TreeNodePatchMeta,
): TreeNode[] {
  const normalized = normalizeTreePath(path);
  return replaceChild(
    nodes,
    (node) => normalizeTreePath(node.path) === normalized,
    (node) => ({
      ...node,
      title: meta.title,
      icon: meta.icon,
      ...(meta.description !== undefined
        ? { description: meta.description }
        : {}),
    }),
  );
}

export function applyReadmeMeta(
  nodes: TreeNode[],
  readmePath: string,
  meta: TreeNodePatchMeta,
): TreeNode[] {
  const normalized = normalizeTreePath(readmePath);
  const folderPath = dirname(normalized);
  if (!folderPath) {
    return updateTreeNodeMeta(nodes, normalized, meta);
  }

  const next = replaceChild(
    nodes,
    (node) => folderPathForNode(node) === folderPath,
    (node) => ({
      ...node,
      path: normalized,
      title: meta.title,
      icon: meta.icon,
      ...(meta.description !== undefined
        ? { description: meta.description }
        : {}),
    }),
  );
  if (next !== nodes) return next;

  return insertIntoParent(nodes, dirname(folderPath), {
    name: basename(folderPath),
    path: normalized,
    title: meta.title,
    icon: meta.icon,
    description: meta.description,
    has_changes: false,
    has_schema: false,
    children: [],
  });
}

export function removeReadmeMeta(
  nodes: TreeNode[],
  readmePath: string,
): TreeNode[] {
  const normalized = normalizeTreePath(readmePath);
  const folderPath = dirname(normalized);
  if (!folderPath) return removeTreePath(nodes, normalized);

  return replaceChild(
    nodes,
    (node) => folderPathForNode(node) === folderPath,
    (node) => ({
      ...node,
      name: basename(folderPath),
      path: folderPath,
      title: basename(folderPath),
      icon: null,
      description: null,
    }),
  );
}

export function updateTreeFolderSchema(
  nodes: TreeNode[],
  folderPath: string,
  hasSchema: boolean,
): TreeNode[] {
  const normalized = normalizeTreePath(folderPath);
  const next = replaceChild(
    nodes,
    (node) => folderPathForNode(node) === normalized,
    (node) => ({ ...node, has_schema: hasSchema }),
  );
  if (next !== nodes || !hasSchema || !normalized) return next;

  return insertIntoParent(nodes, dirname(normalized), {
    name: basename(normalized),
    path: normalized,
    title: basename(normalized),
    icon: null,
    description: null,
    has_changes: false,
    has_schema: true,
    children: [],
  });
}
