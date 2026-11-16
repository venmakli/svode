import type { TreeNode } from "../model/types";
import { treeParentKeyForNode } from "./tree-cache";
import {
  getParentDir,
  isDescendantOf,
  type Projection,
} from "./tree-dnd-utilities";
import { findTreeNode } from "./tree-node-queries";

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

/**
 * The one order section a reorder within its folder writes: the shown
 * children of that folder with the dragged item at its projected place.
 */
export function buildSameParentReorderOrder(input: {
  currentTree: TreeNode[];
  fromNodeName: string;
  parentPath: string;
  projection: Projection;
}): Record<string, string[]> | null {
  const currentSiblings = shownChildNames(input.currentTree, input.parentPath);
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

  return { [orderKey(input.parentPath)]: siblings };
}

/**
 * The one order section written after the move into another folder: the
 * target section with the moved item at its projected place, only while the
 * target shows its children. Otherwise the move itself has already put the
 * item at the end of the target, and nothing more is written.
 */
export function buildCrossParentMoveOrder(input: {
  currentTree: TreeNode[];
  movedNodeName: string;
  parentPath: string;
  projection: Projection;
}): Record<string, string[]> | null {
  const currentSiblings = shownChildNames(input.currentTree, input.parentPath);
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
  return { [orderKey(input.parentPath)]: siblings };
}

function orderKey(parentPath: string): string {
  return parentPath || ".";
}

/**
 * Names of the children the tree shows under a folder ("" for the Space
 * root), or null when the folder is collapsed or not in the tree.
 */
function shownChildNames(
  tree: TreeNode[],
  parentPath: string,
): string[] | null {
  if (!parentPath) return tree.map((node) => node.name);
  const folder = findShownFolder(tree, parentPath);
  if (!folder || folder.children.length === 0) return null;
  return folder.children.map((node) => node.name);
}

function findShownFolder(
  nodes: TreeNode[],
  folderPath: string,
): TreeNode | null {
  for (const node of nodes) {
    if (treeParentKeyForNode(node) === folderPath) return node;
    if (node.children.length > 0) {
      const found = findShownFolder(node.children, folderPath);
      if (found) return found;
    }
  }
  return null;
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
