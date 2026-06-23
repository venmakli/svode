import type { TreeNode } from "../model/types";

export interface SpaceBreadcrumbSegment {
  label: string;
  path: string;
}

function findTitleInTree(nodes: TreeNode[], targetPath: string): string | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node.title;
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (folderPath === targetPath) return node.title;
    if (node.children.length > 0) {
      const found = findTitleInTree(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

export function buildSpaceBreadcrumbSegments(
  docPath: string,
  tree: TreeNode[],
): SpaceBreadcrumbSegment[] {
  const parts = docPath.split("/");
  const segments: SpaceBreadcrumbSegment[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const cumPath = parts.slice(0, i + 1).join("/");

    if (i === parts.length - 1 && part.toLowerCase() === "readme.md") continue;

    if (i < parts.length - 1) {
      const title = findTitleInTree(tree, cumPath) ?? part;
      segments.push({ label: title, path: `${cumPath}/readme.md` });
    } else {
      const title = findTitleInTree(tree, cumPath) ?? part.replace(/\.md$/, "");
      segments.push({ label: title, path: cumPath });
    }
  }

  return segments;
}
