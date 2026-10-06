import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useSpace, type SpaceInfo } from "@/features/space";
import {
  listenHomeProjectWindowsChanged,
  listHomeProjectsInOtherWindows,
} from "../api/home-project-actions";
import {
  firstAvailableHomeProject,
  homeProjectAvailability,
  sortHomeProjects,
  type HomeProjectAvailability,
} from "../model/home-projects";

interface ProjectWindowsState {
  /** Projects bound to other windows; null until first read. */
  otherWindowProjectIds: ReadonlySet<string> | null;
}

const useProjectWindowsStore = create<ProjectWindowsState>(() => ({
  otherWindowProjectIds: null,
}));

function refreshProjectWindows() {
  void listHomeProjectsInOtherWindows()
    .then((ids) =>
      useProjectWindowsStore.setState({ otherWindowProjectIds: new Set(ids) }),
    )
    .catch((err) =>
      console.warn("list_projects_in_other_windows failed:", err),
    );
}

/** Keeps the projects of other windows current while Home shows. */
export function useProjectWindowsLifecycle() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    refreshProjectWindows();
    listenHomeProjectWindowsChanged(refreshProjectWindows)
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((err) =>
        console.warn("listen app-windows:projects-changed failed:", err),
      );
    return () => {
      disposed = true;
      unlisten?.();
      // The next Home waits for a fresh read instead of a stale set.
      useProjectWindowsStore.setState({ otherWindowProjectIds: null });
    };
  }, []);
}

export interface HomeProjects {
  /** The list in the order of the "Projects" group. */
  projects: SpaceInfo[];
  availability: (project: SpaceInfo) => HomeProjectAvailability;
  /** The project Home works with when none is active; null if none can. */
  firstAvailable: SpaceInfo | null;
  /** The projects of other windows were read. */
  loaded: boolean;
}

export function useHomeProjects(): HomeProjects {
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const otherWindowProjectIds = useProjectWindowsStore(
    (state) => state.otherWindowProjectIds,
  );
  return useMemo(() => {
    const otherWindows = otherWindowProjectIds ?? new Set<string>();
    return {
      projects: sortHomeProjects(rootSpaces),
      availability: (project) => homeProjectAvailability(project, otherWindows),
      firstAvailable: firstAvailableHomeProject(rootSpaces, otherWindows),
      loaded: otherWindowProjectIds !== null,
    };
  }, [otherWindowProjectIds, rootSpaces]);
}
