import type { TreeNode } from "../model/types";

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
