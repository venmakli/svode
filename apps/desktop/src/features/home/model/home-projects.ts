import type { SpaceInfo } from "@/features/space";

/** Why Home cannot work with a project now, or that it can. */
export type HomeProjectAvailability =
  | "available"
  | "otherWindow"
  | "missing"
  | "broken";

/** Projects of the list, the last opened first; never opened ones last. */
export function sortHomeProjects(projects: readonly SpaceInfo[]): SpaceInfo[] {
  return [...projects].sort((a, b) => {
    if (!a.lastOpened && !b.lastOpened) return 0;
    if (!a.lastOpened) return 1;
    if (!b.lastOpened) return -1;
    return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
  });
}

export function homeProjectAvailability(
  project: SpaceInfo,
  otherWindowProjectIds: ReadonlySet<string>,
): HomeProjectAvailability {
  if (project.status === "missing" || project.status === "broken") {
    return project.status;
  }
  return otherWindowProjectIds.has(project.id) ? "otherWindow" : "available";
}

/** The first project of the list Home can work with. */
export function firstAvailableHomeProject(
  projects: readonly SpaceInfo[],
  otherWindowProjectIds: ReadonlySet<string>,
): SpaceInfo | null {
  return (
    sortHomeProjects(projects).find(
      (project) =>
        homeProjectAvailability(project, otherWindowProjectIds) === "available",
    ) ?? null
  );
}

/** Ids of projects whose name another project of the list shares. */
export function homeProjectsWithSharedNames(
  projects: readonly SpaceInfo[],
): Set<string> {
  const byName = new Map<string, string[]>();
  for (const project of projects) {
    byName.set(project.name, [...(byName.get(project.name) ?? []), project.id]);
  }
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}
