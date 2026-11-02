import type { TreeNode } from "../model/types";
import { treeParentKeyForNode } from "./tree-cache";
import {
  getParentDir,
  isDescendantOf,
  type Projection,
} from "./tree-dnd-utilities";
import { buildOrderMap, findTreeNode } from "./tree-node-queries";

export interface PreparedTreeDrag {
  fromPath: string;
  fromNode: TreeNode;
  fromParent: string;
  toParent: string;
}

export interface CrossParentMovePlan extends PreparedTreeDrag {
  isBareFolder: boolean;
  isDocFolder: boolean;
  movePath: string;
  readmeFilename: string;
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

export function buildSameParentReorderOrder(input: {
  currentTree: TreeNode[];
  fromNodeName: string;
  parentPath: string;
  projection: Projection;
}): Record<string, string[]> | null {
  const order = buildOrderMap(input.currentTree);
  const dirKey = input.parentPath || ".";
  const currentSiblings = order[dirKey];
  if (!currentSiblings) return null;

  const fromIndex = currentSiblings.indexOf(input.fromNodeName);
  if (fromIndex === -1) return null;

  const siblings = currentSiblings.filter(
    (name) => name !== input.fromNodeName,
  );
  const insertionIndex = projectedSiblingInsertionIndex({
    currentTree: input.currentTree,
    parentPath: input.parentPath,
    projection: input.projection,
    siblings,
  });
  if (insertionIndex === null) return null;

  siblings.splice(insertionIndex, 0, input.fromNodeName);
  if (sameStringArray(currentSiblings, siblings)) return null;

  order[dirKey] = siblings;
  return order;
}

export function buildCrossParentMoveOrder(input: {
  currentTree: TreeNode[];
  movedNodeName: string;
  parentPath: string;
  projection: Projection;
}): Record<string, string[]> | null {
  const order = buildOrderMap(input.currentTree);
  const dirKey = input.parentPath || ".";
  const currentSiblings = order[dirKey];
  if (!currentSiblings) return null;

  const movedIndex = currentSiblings.indexOf(input.movedNodeName);
  if (movedIndex === -1) return null;

  const siblings = currentSiblings.filter(
    (name) => name !== input.movedNodeName,
  );
  const insertionIndex = projectedSiblingInsertionIndex({
    currentTree: input.currentTree,
    parentPath: input.parentPath,
    projection: input.projection,
    siblings,
  });
  if (insertionIndex === null) return null;

  siblings.splice(insertionIndex, 0, input.movedNodeName);
  order[dirKey] = siblings;
  return order;
}

function projectedSiblingInsertionIndex(input: {
  currentTree: TreeNode[];
  parentPath: string;
  projection: Projection;
  siblings: string[];
}): number | null {
  if (input.projection.type === "child") {
    return input.siblings.length;
  }

  const overNode = findTreeNode(input.currentTree, input.projection.overPath);
  if (!overNode) return null;

  const overIndex = input.siblings.indexOf(overNode.name);
  if (overIndex !== -1) {
    return input.projection.type === "after" ? overIndex + 1 : overIndex;
  }

  const overFolderPath = treeParentKeyForNode(overNode);
  if (
    input.projection.type === "after" &&
    overFolderPath === input.parentPath
  ) {
    return 0;
  }

  return input.siblings.length;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

export function buildCrossParentMovePlan(
  tree: TreeNode[],
  drag: PreparedTreeDrag,
): CrossParentMovePlan {
  const isBareFolder = !drag.fromPath.endsWith(".md");
  const folderPath = treeParentKeyForNode(drag.fromNode);
  const isDocFolder = !isBareFolder && folderPath !== null;

  return {
    ...drag,
    isBareFolder,
    isDocFolder,
    movePath: isDocFolder && folderPath ? folderPath : drag.fromPath,
    readmeFilename: drag.fromPath.split("/").pop() ?? "README.md",
  };
}

export function movedPagePath(
  plan: CrossParentMovePlan,
  newPath: string,
): string {
  return plan.isDocFolder ? `${newPath}/${plan.readmeFilename}` : newPath;
}
