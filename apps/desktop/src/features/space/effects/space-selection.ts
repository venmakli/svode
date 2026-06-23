import {
  openEntryDocument,
  openEntryScopeHome,
} from "@/features/entry/selection";
import type { TreeNode } from "@/features/entry";

function hasScopeReadme(nodes: TreeNode[]): boolean {
  return nodes.some((node) => node.path.toLowerCase() === "readme.md");
}

export function openScopeHomeSelection(spaceId: string, tree: TreeNode[]) {
  if (hasScopeReadme(tree)) {
    openEntryDocument("README.md", spaceId);
  } else {
    openEntryScopeHome(spaceId);
  }
}

export function openSpaceReadmeDocument(spaceId: string) {
  openEntryDocument("README.md", spaceId);
}
