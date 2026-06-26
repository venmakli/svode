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

export interface ProjectionIntent {
  placement: "before" | "after";
  allowChild: boolean;
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

export function removeDescendantsOf(
  flatItems: FlattenedItem[],
  activePath: string | null,
): FlattenedItem[] {
  if (!activePath) return flatItems;

  const activeItem = flatItems.find((item) => item.path === activePath);
  if (!activeItem) return flatItems;

  const folderPath = folderPathForItem(activeItem);
  if (!folderPath) return flatItems;

  return flatItems.filter((item) => {
    if (item.path === activePath) return true;
    return (
      item.parentPath !== folderPath &&
      !isDescendantOf(item.parentPath, folderPath)
    );
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
  intent?: ProjectionIntent | null,
): Projection | null {
  const activeIndex = flatItems.findIndex((item) => item.path === activeId);
  const overIndex = flatItems.findIndex((item) => item.path === overId);
  if (overIndex === -1 || activeIndex === -1) return null;
  if (activeId === overId) return null;

  const activeItem = flatItems[activeIndex];
  const overItem = flatItems[overIndex];
  const dragDepth = Math.round(offsetLeft / INDENT_WIDTH);
  const projectedDepth = activeItem.depth + dragDepth;

  if (
    intent?.allowChild &&
    projectedDepth > overItem.depth &&
    !isDescendantOf(overItem.path, folderPathForItem(activeItem) ?? activeId)
  ) {
    return {
      depth: overItem.depth + 1,
      parentPath: childParentPathForItem(overItem),
      type: "child",
      overPath: overItem.path,
    };
  }

  const placement =
    intent?.placement ?? (activeIndex < overIndex ? "after" : "before");
  const withoutActive = flatItems.filter((_, index) => index !== activeIndex);
  const overIndexWithoutActive = withoutActive.findIndex(
    (item) => item.path === overId,
  );
  if (overIndexWithoutActive === -1) return null;

  const insertionIndex =
    placement === "after" ? overIndexWithoutActive + 1 : overIndexWithoutActive;
  const newItems = [
    ...withoutActive.slice(0, insertionIndex),
    activeItem,
    ...withoutActive.slice(insertionIndex),
  ];
  const previousItem = newItems[insertionIndex - 1] as
    | FlattenedItem
    | undefined;
  const nextItem = newItems[insertionIndex + 1] as FlattenedItem | undefined;

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
  const parentPath = getParentPathForDepth(newItems, insertionIndex, depth);

  return { depth, parentPath, type: placement, overPath: overId };
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
      return childParentPathForItem(item);
    }
  }
  return "";
}

function folderPathForItem(item: FlattenedItem): string | null {
  if (!item.path.endsWith(".md")) return item.path;
  if (/(^|\/)readme\.md$/i.test(item.path)) {
    return item.path.replace(/\/readme\.md$/i, "");
  }
  if (item.hasChildren) return item.path.replace(/\.md$/i, "");
  return null;
}

function childParentPathForItem(item: FlattenedItem): string {
  return folderPathForItem(item) ?? item.path.replace(/\.md$/i, "");
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
