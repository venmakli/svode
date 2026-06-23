import { arrayMove } from "@dnd-kit/sortable";
import type { TreeNode } from "../model/types";
import { treeNodeHasChildren, treeParentKeyForNode } from "./tree-cache";

// SidebarMenuSub CSS: ml-2 (8px) + pl-2 (8px) = 16px per nesting level
export const INDENT_WIDTH = 16;

export interface FlattenedItem {
  path: string;
  name: string;
  title: string;
  icon: string | null;
  parentPath: string; // "" for root-level items
  depth: number;
  index: number; // index among siblings
  hasChildren: boolean;
}

export interface Projection {
  depth: number;
  parentPath: string; // "" for root, folder path for nesting
  type: "before" | "after" | "child";
  overPath: string; // path of the item we're projecting relative to
}

/**
 * Flatten a TreeNode[] into a flat list with depth/parent metadata.
 * Only includes visible items (caller should handle collapsed filtering).
 */
export function flattenTree(
  nodes: TreeNode[],
  parentPath = "",
  depth = 0,
): FlattenedItem[] {
  const result: FlattenedItem[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const hasChildren = treeNodeHasChildren(node);
    result.push({
      path: node.path,
      name: node.name,
      title: node.title,
      icon: node.icon,
      parentPath,
      depth,
      index: i,
      hasChildren,
    });
    if (node.children.length > 0) {
      const folderPath = treeParentKeyForNode(node) ?? node.path;
      result.push(...flattenTree(node.children, folderPath, depth + 1));
    }
  }
  return result;
}

/**
 * Remove items whose ancestors are collapsed (not in expandedPaths).
 * A folder is "collapsed" if its path is NOT in the expandedPaths set.
 */
export function removeCollapsedChildren(
  flatItems: FlattenedItem[],
  expandedPaths: Set<string>,
): FlattenedItem[] {
  const hiddenParents = new Set<string>();
  return flatItems.filter((item) => {
    // Check if any ancestor is hidden
    if (item.parentPath && hiddenParents.has(item.parentPath)) {
      // This item is under a hidden parent — also hide it
      if (item.hasChildren) {
        const folderPath = item.path.replace(/\/readme\.md$/i, "");
        hiddenParents.add(folderPath);
      }
      return false;
    }
    // If this is a folder and it's collapsed, mark its children for hiding
    if (item.hasChildren) {
      const folderPath = item.path.replace(/\/readme\.md$/i, "");
      if (!expandedPaths.has(item.path)) {
        hiddenParents.add(folderPath);
      }
    }
    return true;
  });
}

/**
 * Simulate moving activeId to overId position, then compute the projected
 * depth/parent based on horizontal cursor offset.
 *
 * Algorithm adapted from Shaddix/dnd-kit-sortable-tree:
 * 1. arrayMove active → over position
 * 2. previousItem (above) determines maxDepth
 * 3. nextItem (below) determines minDepth
 * 4. Horizontal offset selects depth within [min, max]
 * 5. Depth determines parentPath and type
 */
export function getProjection(
  flatItems: FlattenedItem[],
  activeId: string,
  overId: string,
  offsetLeft: number,
): Projection | null {
  const activeIndex = flatItems.findIndex((item) => item.path === activeId);
  const overIndex = flatItems.findIndex((item) => item.path === overId);
  if (overIndex === -1 || activeIndex === -1) return null;

  const activeItem = flatItems[activeIndex];

  // Simulate the move: place active at over's position
  const newItems = arrayMove(flatItems, activeIndex, overIndex);
  // After move, active is now at overIndex
  const previousItem = newItems[overIndex - 1] as FlattenedItem | undefined;
  const nextItem = newItems[overIndex + 1] as FlattenedItem | undefined;

  const dragDepth = Math.round(offsetLeft / INDENT_WIDTH);
  const projectedDepth = activeItem.depth + dragDepth;

  // maxDepth: previous item's depth + 1 (can nest as child of previous item)
  // If no previous item, max is 0 (root level)
  const maxDepth = previousItem ? previousItem.depth + 1 : 0;

  // minDepth: next item's depth (can't be shallower than the item below)
  // If no next item, min is 0 (root level)
  const minDepth = nextItem ? nextItem.depth : 0;

  // Impossible position — no valid depth exists
  if (minDepth > maxDepth) return null;

  // Special case: user offsets right beyond maxDepth — try nesting into the next item
  // This happens when dragging above the first child of a folder and offsetting right
  if (projectedDepth > maxDepth && nextItem) {
    const nestDepth = nextItem.depth + 1;
    if (projectedDepth >= nestDepth) {
      const overFolderPath = nextItem.hasChildren
        ? nextItem.path.replace(/\/readme\.md$/i, "")
        : nextItem.path.replace(/\.md$/i, "");
      return {
        depth: nestDepth,
        parentPath: overFolderPath,
        type: "child",
        overPath: nextItem.path,
      };
    }
  }

  // Clamp
  const depth = Math.max(minDepth, Math.min(maxDepth, projectedDepth));

  // Determine parentPath by walking backwards to find the parent at depth-1
  const parentPath = getParentPathForDepth(newItems, overIndex, depth);

  // Determine type:
  // - If depth === previousItem.depth + 1: nesting as child of previous item
  // - Otherwise: sibling placement (before/after)
  if (
    previousItem &&
    depth === previousItem.depth + 1 &&
    previousItem.hasChildren
  ) {
    // If the over item is already a child of this folder, it's a reorder ("before"), not nesting
    const folderPath = previousItem.path.replace(/\/readme\.md$/i, "");
    const originalOverItem = flatItems.find((i) => i.path === overId);
    if (originalOverItem && originalOverItem.parentPath === folderPath) {
      return { depth, parentPath, type: "before", overPath: overId };
    }
    return { depth, parentPath, type: "child", overPath: previousItem.path };
  }

  // Nesting into a simple file — will need auto-nest (file → folder conversion)
  if (
    previousItem &&
    depth === previousItem.depth + 1 &&
    !previousItem.hasChildren
  ) {
    const prevFolderPath = previousItem.path.replace(/\.md$/i, "");
    return {
      depth,
      parentPath: prevFolderPath,
      type: "child",
      overPath: previousItem.path,
    };
  }

  const type = activeIndex < overIndex ? "after" : "before";
  return { depth, parentPath, type, overPath: overId };
}

/**
 * Find the correct parentPath for a given depth by walking backwards
 * through the (reordered) flat list.
 */
function getParentPathForDepth(
  items: FlattenedItem[],
  fromIndex: number,
  targetDepth: number,
): string {
  if (targetDepth === 0) return "";

  // Walk backwards to find the nearest item at depth = targetDepth - 1
  for (let i = fromIndex - 1; i >= 0; i--) {
    const item = items[i];
    if (item.depth < targetDepth) {
      // This is our parent (or an ancestor)
      if (item.hasChildren) {
        return item.path.replace(/\/readme\.md$/i, "");
      }
      // Non-folder at parent depth — will become a folder via nest_entry
      return item.path.replace(/\.md$/i, "");
    }
  }
  return "";
}

/** Check if `path` is a descendant of `ancestorPath`. */
export function isDescendantOf(path: string, ancestorPath: string): boolean {
  if (!ancestorPath) return false;
  const folderPrefix = ancestorPath.endsWith("/")
    ? ancestorPath
    : ancestorPath + "/";
  return path.startsWith(folderPrefix);
}

/** Get the parent directory of a relative path. Returns "" for root-level items. */
export function getParentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.substring(0, idx);
}
