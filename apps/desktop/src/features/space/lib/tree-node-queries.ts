import type { TreeNode } from "../model/types";

export function buildOrderMap(
  nodes: TreeNode[],
  dirKey = ".",
): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  order[dirKey] = nodes.map((node) => node.name);
  for (const node of nodes) {
    if (node.children.length > 0) {
      const nodeDir = node.path.replace(/\/readme\.md$/i, "");
      Object.assign(order, buildOrderMap(node.children, nodeDir));
    }
  }
  return order;
}

export function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children.length > 0) {
      const found = findTreeNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function findParentTreeNode(
  nodes: TreeNode[],
  childPath: string,
): TreeNode | null {
  for (const node of nodes) {
    if (node.children.some((child) => child.path === childPath)) return node;
    const found = findParentTreeNode(node.children, childPath);
    if (found) return found;
  }
  return null;
}
