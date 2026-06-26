import type { GitStatus } from "./types";
import {
  containerPathForNodePath,
  isGitStatusPathDescendant,
  joinGitStatusPath,
  normalizeGitStatusPath,
} from "./git-paths";

export type GitSaveScopeLabel = "document" | "folder" | "collection" | "space";

export type GitSaveScope =
  | { kind: "file"; path: string; label: "document" }
  | {
      kind: "container";
      path: string;
      nodePath: string;
      hasSchema: boolean;
      label: Exclude<GitSaveScopeLabel, "space">;
    }
  | { kind: "space"; path: ""; label: "space" };

export interface GitSaveScopeTreeNode {
  path: string;
  has_schema?: boolean;
  hasChildren?: boolean;
  has_children?: boolean;
  kind?: "document" | "folder" | "collection";
  children?: readonly GitSaveScopeTreeNode[];
}

export function resolveGitSaveAllScope(input: {
  activePath: string | null;
  tree: readonly GitSaveScopeTreeNode[];
}): GitSaveScope {
  const activePath = normalizeGitStatusPath(input.activePath ?? "");
  if (!activePath || activePath.toLowerCase() === "readme.md") {
    return { kind: "space", path: "", label: "space" };
  }

  const nodeChain = findNodeChain(input.tree, activePath);
  if (nodeChain.length === 0) {
    return { kind: "file", path: activePath, label: "document" };
  }

  const activeNode = nodeChain.at(-1);
  if (activeNode && isContainerNode(activeNode)) {
    return containerScopeFromNode(activeNode);
  }

  for (let index = nodeChain.length - 2; index >= 0; index -= 1) {
    const node = nodeChain[index];
    if (isContainerNode(node)) {
      return containerScopeFromNode(node);
    }
  }

  return { kind: "file", path: activePath, label: "document" };
}

export function dirtyPathsForGitSaveScope(
  status: GitStatus | null | undefined,
  scope: GitSaveScope,
  extraPaths: readonly string[] = [],
): string[] {
  const paths: string[] = [];
  for (const file of status?.files ?? []) {
    if (gitSaveScopeContainsPath(scope, file.path)) {
      paths.push(file.path);
    }
  }
  for (const path of extraPaths) {
    if (gitSaveScopeContainsPath(scope, path)) {
      paths.push(path);
    }
  }
  return uniqueGitStatusPaths(paths);
}

export function gitStatusHasDirtyPath(
  status: GitStatus | null | undefined,
  path: string | null | undefined,
): boolean {
  const normalized = normalizeGitStatusPath(path ?? "");
  if (!normalized) return false;
  return (status?.files ?? []).some(
    (file) => normalizeGitStatusPath(file.path) === normalized,
  );
}

export function gitSaveScopeContainsPath(
  scope: GitSaveScope,
  path: string,
): boolean {
  const normalized = normalizeGitStatusPath(path);
  switch (scope.kind) {
    case "space":
      return normalized !== "";
    case "file":
      return normalized === scope.path;
    case "container":
      return isGitStatusPathDescendant(normalized, scope.path);
  }
}

function findNodeChain(
  nodes: readonly GitSaveScopeTreeNode[],
  targetPath: string,
): GitSaveScopeTreeNode[] {
  for (const node of nodes) {
    const nodePath = normalizeGitStatusPath(node.path);
    const containerPath = containerPathForNodePath(nodePath);
    if (nodePath === targetPath || containerPath === targetPath) {
      return [node];
    }
    const childChain = findNodeChain(node.children ?? [], targetPath);
    if (childChain.length > 0) {
      return [node, ...childChain];
    }
  }
  return [];
}

function isContainerNode(node: GitSaveScopeTreeNode): boolean {
  const path = normalizeGitStatusPath(node.path);
  return (
    !path.endsWith(".md") ||
    node.has_schema === true ||
    node.hasChildren === true ||
    node.has_children === true ||
    (node.children?.length ?? 0) > 0
  );
}

function containerScopeFromNode(node: GitSaveScopeTreeNode): GitSaveScope {
  const hasSchema = node.has_schema === true;
  return {
    kind: "container",
    path: containerPathForNodePath(node.path),
    nodePath: normalizeGitStatusPath(node.path),
    hasSchema,
    label: scopeLabelForNode(node, hasSchema),
  };
}

function scopeLabelForNode(
  node: GitSaveScopeTreeNode,
  hasSchema: boolean,
): Exclude<GitSaveScopeLabel, "space"> {
  if (hasSchema || node.kind === "collection") return "collection";
  if (
    node.kind === "folder" ||
    !normalizeGitStatusPath(node.path).endsWith(".md")
  ) {
    return "folder";
  }
  return "document";
}

function uniqueGitStatusPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = normalizeGitStatusPath(path);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

export function selfPathsForGitSaveScope(scope: GitSaveScope): string[] {
  switch (scope.kind) {
    case "space":
      return ["README.md"];
    case "file":
      return [scope.path];
    case "container": {
      return [scope.nodePath || joinGitStatusPath(scope.path, "README.md")];
    }
  }
}
