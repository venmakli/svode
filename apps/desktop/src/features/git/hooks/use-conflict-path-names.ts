import { useMemo } from "react";
import { useSpace, type TreeNode } from "@/features/space";
import type { GitPathConflict, GitSyncStop } from "../model";
import {
  conflictPathName,
  type ConflictNameSpace,
} from "../ui/conflict-path-names";

/**
 * Names conflicted paths of the repository at `repositoryPath`: a Page by
 * the title `stop` carries for it, otherwise by the sidebar tree.
 */
export function useConflictPathNames(
  repositoryPath: string,
  stop: GitSyncStop | null,
): (path: string) => string {
  // A Space store read before the project opens has no lists yet.
  const rootSpaces = useSpace((state) => state.rootSpaces ?? NO_SPACES);
  const spaces = useSpace((state) => state.spaces ?? NO_SPACES);
  const fileTrees = useSpace((state) => state.fileTrees ?? NO_TREES);
  const conflicts =
    stop?.kind === "incoming"
      ? stop.files
      : stop?.kind === "conflict" ||
          stop?.kind === "unmerged" ||
          stop?.kind === "operation"
        ? stop.kinds
        : NO_CONFLICTS;
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
    const names = new Map(
      conflicts.map((conflict) => [conflict.path, conflict.name]),
    );
    return (path: string) =>
      conflictPathName(repositoryPath, path, named, names.get(path));
  }, [conflicts, fileTrees, repositoryPath, rootSpaces, spaces]);
}

const NO_SPACES: never[] = [];
const NO_TREES = {};
const NO_CONFLICTS: GitPathConflict[] = [];
