import { useEntrySelectionStore, type TreeNode } from "@/features/entry";

function hasScopeReadme(nodes: TreeNode[]): boolean {
  return nodes.some((node) => node.path.toLowerCase() === "readme.md");
}

export function openScopeHomeSelection(spaceId: string, tree: TreeNode[]) {
  const selection = useEntrySelectionStore.getState();
  if (hasScopeReadme(tree)) {
    selection.openDocument("README.md", spaceId);
  } else {
    selection.openScopeHome(spaceId);
  }
}

export function openSpaceReadmeDocument(spaceId: string) {
  useEntrySelectionStore.getState().openDocument("README.md", spaceId);
}
