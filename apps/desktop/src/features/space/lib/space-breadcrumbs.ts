import type { TreeNode } from "../model/types";

export interface SpaceBreadcrumbSegment {
  label: string;
  path: string;
  ownerKind: "collection" | null;
}

function findNodeInTree(
  nodes: TreeNode[],
  targetPath: string,
): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (folderPath === targetPath) return node;
    if (node.children.length > 0) {
      const found = findNodeInTree(node.children, targetPath);
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
      const node = findNodeInTree(tree, cumPath);
      const isCollectionOwner = Boolean(node?.has_schema);
      segments.push({
        label: node?.title ?? part,
        path: isCollectionOwner
          ? cumPath
          : (node?.path ?? `${cumPath}/README.md`),
        ownerKind: isCollectionOwner ? "collection" : null,
      });
    } else {
      const node = findNodeInTree(tree, cumPath);
      segments.push({
        label: node?.title ?? part.replace(/\.md$/, ""),
        path: cumPath,
        ownerKind: node?.has_schema ? "collection" : null,
      });
    }
  }

  return segments;
}
