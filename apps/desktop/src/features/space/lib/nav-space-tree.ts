import type { TreeNode } from "@/features/entry";

export function visibleScopeChildren(tree: TreeNode[]): TreeNode[] {
  return tree.filter((node) => node.path.toLowerCase() !== "readme.md");
}

export function hasScopeReadme(tree: TreeNode[]): boolean {
  return tree.some((node) => node.path.toLowerCase() === "readme.md");
}

export function hasRecordKey<T>(
  record: Record<string, T>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
