import { useMemo } from "react";
import { useSpace, type TreeNode } from "@/features/space";
import {
  conflictPathName,
  type ConflictNameSpace,
} from "../ui/conflict-path-names";

/** Names conflicted paths of the repository at `repositoryPath`. */
export function useConflictPathNames(
  repositoryPath: string,
): (path: string) => string {
  // A Space store read before the project opens has no lists yet.
  const rootSpaces = useSpace((state) => state.rootSpaces ?? NO_SPACES);
  const spaces = useSpace((state) => state.spaces ?? NO_SPACES);
  const fileTrees = useSpace((state) => state.fileTrees ?? NO_TREES);
  return useMemo(() => {
    const named: ConflictNameSpace[] = [...rootSpaces, ...spaces].map(
      (space) => {
        const nodes = new Map<string, string>();
        const visit = (children: TreeNode[]) => {
          for (const node of children) {
            nodes.set(node.path, node.title);
            visit(node.children);
          }
        };
        visit(fileTrees[space.id] ?? []);
        return { path: space.path, name: space.name, nodes };
      },
    );
    return (path: string) => conflictPathName(repositoryPath, path, named);
  }, [fileTrees, repositoryPath, rootSpaces, spaces]);
}

const NO_SPACES: never[] = [];
const NO_TREES = {};
