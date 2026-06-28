import type { ChildrenByParentPath } from "./tree-cache";
import { ROOT_TREE_PARENT, treeParentKeyForNode } from "./tree-cache";
import { normalizeTreePath } from "./tree-patches";

export type SidebarTreeExpansionAction = "collapse" | "expand";

interface SidebarTreeExpandedStateInput {
  expandedPaths: Record<string, string[]>;
  scopeOpenById: Record<string, boolean>;
  spaceIds: string[];
}

export function loadedExpandableTreePaths(
  childrenByParentPath: ChildrenByParentPath | undefined,
): string[] {
  if (!childrenByParentPath) return [];

  const paths = new Set<string>();
  for (const children of Object.values(childrenByParentPath)) {
    for (const node of children) {
      const childParentKey = treeParentKeyForNode(node);
      if (!childParentKey || childParentKey === ROOT_TREE_PARENT) continue;

      const loadedChildren = childrenByParentPath[childParentKey];
      if (!loadedChildren || loadedChildren.length === 0) continue;

      paths.add(normalizeTreePath(node.path));
    }
  }

  return Array.from(paths);
}

export function sidebarTreeExpansionPaths(
  action: SidebarTreeExpansionAction,
  childrenByParentPath: ChildrenByParentPath | undefined,
): string[] {
  return action === "expand"
    ? loadedExpandableTreePaths(childrenByParentPath)
    : [];
}

export function hasExpandedSidebarTreeState({
  expandedPaths,
  scopeOpenById,
  spaceIds,
}: SidebarTreeExpandedStateInput): boolean {
  return spaceIds.some(
    (spaceId) =>
      scopeOpenById[spaceId] === true ||
      (expandedPaths[spaceId]?.length ?? 0) > 0,
  );
}

export function nextSidebarTreeExpansionAction(
  input: SidebarTreeExpandedStateInput,
): SidebarTreeExpansionAction {
  return hasExpandedSidebarTreeState(input) ? "collapse" : "expand";
}
