import {
  containerPathForNodePath,
  isGitStatusPathDescendant,
  normalizeGitStatusPath,
  type GitStatus,
} from "@/features/git";

export interface ChangesTarget {
  kind: "page" | "owner" | "space" | "project";
  sourceShape: "file" | "directory";
  spacePath: string;
  projectPath?: string | null;
  sessionKey?: number;
  path: string;
  name: string;
}

export interface InspectionScope {
  kind: "file" | "directory" | "repository";
  spacePath: string;
  path: string;
}

export function resolveInspectionScope(target: ChangesTarget): InspectionScope {
  if (target.kind === "space" || target.kind === "project")
    return { kind: "repository", spacePath: target.spacePath, path: "" };
  const path = normalizeGitStatusPath(target.path);
  if (target.kind === "page" && target.sourceShape === "file")
    return { kind: "file", spacePath: target.spacePath, path };
  return {
    kind: "directory",
    spacePath: target.spacePath,
    path: containerPathForNodePath(path),
  };
}

export function inspectionPaths(
  scope: InspectionScope,
  status: GitStatus | undefined,
) {
  return [
    ...new Set(
      (status?.files ?? [])
        .map((file) => normalizeGitStatusPath(file.path))
        .filter((path) => {
          if (scope.kind === "file") return path === scope.path;
          return (
            scope.kind === "repository" ||
            isGitStatusPathDescendant(path, scope.path)
          );
        }),
    ),
  ];
}
