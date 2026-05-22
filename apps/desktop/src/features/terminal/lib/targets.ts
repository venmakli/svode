import type { SpaceInfo } from "@/types/space";
import type { TerminalTarget } from "@/features/terminal/model/types";

export function buildProjectTerminalTarget(project: {
  id: string | null;
  name: string | null;
  path: string | null;
}): TerminalTarget | null {
  if (!project.id || !project.path) return null;
  return {
    scope: "project",
    scopeId: project.id,
    name: project.name?.trim() || "Project",
    path: project.path,
    secondaryPath: project.path,
  };
}

export function buildSpaceTerminalTargets(
  spaces: SpaceInfo[],
): TerminalTarget[] {
  return spaces
    .filter((space) => space.status === "ready")
    .map((space) => ({
      scope: "space" as const,
      scopeId: space.id,
      name: space.name,
      path: space.path,
      secondaryPath: space.path,
    }));
}
