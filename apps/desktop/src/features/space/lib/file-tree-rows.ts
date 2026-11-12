import type { TreeNode } from "../model/types";
import { treeNodeHasChildren, treeParentKeyForNode } from "./tree-cache";
import { INDENT_WIDTH } from "./tree-dnd-utilities";

/** Height of a tree row, `h-7` of the sidebar sub button. */
export const TREE_ROW_HEIGHT = 28;
/** A row with a name conflict shows its path under the title. */
export const TREE_CONFLICT_ROW_HEIGHT = 40;

// The rows used to be nested `SidebarMenuSub` lists: each list has `py-0.5`
// and `gap-1` between its items, and a nested list is shifted by `ml-2 pl-2`
// plus its `translate-x-px`. The flat list keeps that geometry.
const LIST_PADDING = 2;
const ITEM_GAP = 4;
const ROOT_LIST_PADDING_LEFT = 8;

export type FileTreeRow =
  | {
      kind: "node";
      key: string;
      node: TreeNode;
      depth: number;
      expandable: boolean;
      expanded: boolean;
      /** Space above the row that the nested lists used to put there. */
      spaceBefore: number;
    }
  | {
      kind: "loading";
      key: string;
      depth: number;
      index: number;
      spaceBefore: number;
    };

export interface FileTreeRows {
  rows: FileTreeRow[];
  /** Space below the last row: the bottom padding of every open list. */
  trailingSpace: number;
  indexByPath: Map<string, number>;
  nodeByPath: Map<string, TreeNode>;
}

export function isBareFolderNode(node: TreeNode): boolean {
  return !node.path.endsWith(".md");
}

/** Whether a row shows its children when expanded, as the row decides. */
export function treeNodeExpandable(node: TreeNode): boolean {
  const knownChildren = treeNodeHasChildren(node);
  return node.has_app ? knownChildren : isBareFolderNode(node) || knownChildren;
}

/** Whether the main area highlights this row when it shows its path. */
export function treeNodeActivatable(node: TreeNode): boolean {
  return !isBareFolderNode(node) || Boolean(node.has_app);
}

/**
 * The visible rows of a tree in display order: a row per shown node and the
 * loading placeholders of an expanded folder whose children are loading.
 */
export function buildFileTreeRows(
  tree: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  loadingParents: Readonly<Record<string, boolean>> | undefined,
): FileTreeRows {
  const rows: FileTreeRow[] = [];
  const indexByPath = new Map<string, number>();
  const nodeByPath = new Map<string, TreeNode>();
  let pending = 0;

  const takeSpace = () => {
    const space = pending;
    pending = 0;
    return space;
  };

  const loadingRows = (parentKey: string, depth: number) => {
    pending += LIST_PADDING;
    for (let index = 0; index < 2; index++) {
      if (index > 0) pending += ITEM_GAP;
      rows.push({
        kind: "loading",
        key: `${parentKey}\u0000loading-${index}`,
        depth,
        index,
        spaceBefore: takeSpace(),
      });
    }
    pending += LIST_PADDING;
  };

  const list = (nodes: readonly TreeNode[], depth: number) => {
    pending += LIST_PADDING;
    nodes.forEach((node, position) => {
      if (position > 0) pending += ITEM_GAP;
      const expandable = treeNodeExpandable(node);
      const isExpanded = expanded.has(node.path);
      indexByPath.set(node.path, rows.length);
      nodeByPath.set(node.path, node);
      rows.push({
        kind: "node",
        key: node.path,
        node,
        depth,
        expandable,
        expanded: isExpanded,
        spaceBefore: takeSpace(),
      });
      if (!expandable || !isExpanded) return;
      const parentKey = treeParentKeyForNode(node);
      const childLoading = parentKey
        ? (loadingParents?.[parentKey] ?? false)
        : false;
      if (childLoading && node.children.length === 0) {
        loadingRows(node.path, depth + 1);
      } else {
        list(node.children, depth + 1);
      }
    });
    pending += LIST_PADDING;
  };

  list(tree, 0);
  return { rows, trailingSpace: pending, indexByPath, nodeByPath };
}

/** The row height before the row is measured. */
export function estimateTreeRowHeight(row: FileTreeRow): number {
  return row.kind === "node" && row.node.name_conflict?.conflicts[0]
    ? TREE_CONFLICT_ROW_HEIGHT
    : TREE_ROW_HEIGHT;
}

/** Horizontal place of a row inside the root list, by its depth. */
export function treeRowInset(depth: number): { left: number; right: number } {
  return {
    left: ROOT_LIST_PADDING_LEFT + depth * (INDENT_WIDTH + 1),
    right: -depth,
  };
}
