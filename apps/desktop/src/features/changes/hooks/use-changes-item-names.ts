import { useMemo } from "react";
import { useSpace, type TreeNode } from "@/features/space";

export function useChangesItemNames(spacePath: string) {
  const tree = useSpace((state) => {
    const space = [...state.rootSpaces, ...state.spaces].find(
      (space) => space.path === spacePath,
    );
    return space ? state.fileTrees[space.id] : undefined;
  });
  return useMemo(() => {
    const names = new Map<string, string>();
    const visit = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        names.set(node.path, node.title);
        visit(node.children);
      }
    };
    visit(tree ?? []);
    return names;
  }, [tree]);
}
