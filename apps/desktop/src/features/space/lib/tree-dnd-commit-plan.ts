import type { TreeNode } from "../model/types";
import { treeParentKeyForNode } from "./tree-cache";
import {
  getParentDir,
  isDescendantOf,
  type Projection,
} from "./tree-dnd-utilities";
import {
  buildOrderMap,
  findParentTreeNode,
  findTreeNode,
} from "./tree-node-queries";

export interface PreparedTreeDrag {
  fromPath: string;
  fromNode: TreeNode;
  fromParent: string;
  toParent: string;
}

export interface ChildNestConversionPlan {
  targetPath: string;
  oldName: string;
  newName: string;
}

export interface CrossParentMovePlan extends PreparedTreeDrag {
  oldParentReadme: string | null;
  isBareFolder: boolean;
  isDocFolder: boolean;
  movePath: string;
  readmeFilename: string;
}

export function readmeFolderPath(path: string): string {
  return path.replace(/\/readme\.md$/i, "");
}

export function prepareTreeDrag(
  tree: TreeNode[],
  fromPath: string,
  projection: Projection,
): PreparedTreeDrag | null {
  const fromNode = findTreeNode(tree, fromPath);
  if (!fromNode) return null;

  const fromNodeFolderPath = treeParentKeyForNode(fromNode);
  const fromFolderPath = fromNodeFolderPath ?? fromPath;
  if (isDescendantOf(projection.parentPath, fromFolderPath)) {
    return null;
  }

  return {
    fromPath,
    fromNode,
    fromParent: getParentDir(fromNodeFolderPath ?? fromPath),
    toParent: projection.parentPath,
  };
}

export function getChildNestConversionPlan(
  tree: TreeNode[],
  projection: Projection,
): ChildNestConversionPlan | null {
  if (projection.type !== "child") return null;

  const targetNode = findTreeNode(tree, projection.overPath);
  const targetIsFolderNode = targetNode && treeParentKeyForNode(targetNode);
  if (!targetNode || targetIsFolderNode) {
    return null;
  }

  return {
    targetPath: projection.overPath,
    oldName: targetNode.name,
    newName: targetNode.name.replace(/\.md$/i, ""),
  };
}

export function buildNestConversionOrder(
  tree: TreeNode[],
  plan: ChildNestConversionPlan,
): Record<string, string[]> | null {
  if (plan.newName === plan.oldName) return null;

  const order = buildOrderMap(tree);
  for (const siblings of Object.values(order)) {
    const index = siblings.indexOf(plan.oldName);
    if (index !== -1) {
      siblings[index] = plan.newName;
      return order;
    }
  }
  return null;
}

export function buildSameParentReorderOrder(input: {
  currentTree: TreeNode[];
  fromNodeName: string;
  parentPath: string;
  projection: Projection;
}): Record<string, string[]> | null {
  const overNode = findTreeNode(input.currentTree, input.projection.overPath);
  if (!overNode) return null;

  const order = buildOrderMap(input.currentTree);
  const dirKey = input.parentPath || ".";
  const siblings = order[dirKey];
  if (!siblings) return null;

  const fromIndex = siblings.indexOf(input.fromNodeName);
  const overIndex = siblings.indexOf(overNode.name);
  if (fromIndex === -1 || overIndex === -1 || fromIndex === overIndex) {
    return null;
  }

  siblings.splice(fromIndex, 1);
  const adjustedIndex = fromIndex < overIndex ? overIndex - 1 : overIndex;
  siblings.splice(
    input.projection.type === "after" ? adjustedIndex + 1 : adjustedIndex,
    0,
    input.fromNodeName,
  );
  return order;
}

export function buildCrossParentMovePlan(
  tree: TreeNode[],
  drag: PreparedTreeDrag,
): CrossParentMovePlan {
  const oldParentTreeNode = drag.fromParent
    ? findParentTreeNode(tree, drag.fromPath)
    : null;
  const oldParentReadme = oldParentTreeNode?.path
    .toLowerCase()
    .endsWith("/readme.md")
    ? oldParentTreeNode.path
    : null;
  const isBareFolder = !drag.fromPath.endsWith(".md");
  const folderPath = treeParentKeyForNode(drag.fromNode);
  const isDocFolder = !isBareFolder && folderPath !== null;

  return {
    ...drag,
    oldParentReadme,
    isBareFolder,
    isDocFolder,
    movePath: isDocFolder && folderPath ? folderPath : drag.fromPath,
    readmeFilename: drag.fromPath.split("/").pop() ?? "README.md",
  };
}

export function movedDocumentPath(
  plan: CrossParentMovePlan,
  newPath: string,
): string {
  return plan.isDocFolder ? `${newPath}/${plan.readmeFilename}` : newPath;
}
