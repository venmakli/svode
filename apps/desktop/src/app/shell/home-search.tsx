import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useHomeProjects, type HomeProjectAvailability } from "@/features/home";
import {
  artifactNavigationKey,
  type NavigationResolvedItem,
} from "@/features/navigation";
import {
  CommandPalette,
  useOpenCommandPalette,
  useOpenProjectSearch,
  useSearchProjectId,
  type SearchNavigationTarget,
} from "@/features/search/app-shell";
import {
  getSpaceSnapshot,
  readProjectSpaces,
  useSpace,
  type SpaceInfo,
} from "@/features/space";
import { pathExists } from "@/platform/filesystem/path-api";
import { sendProjectWindowRequest } from "@/platform/space/space-api";
import { useOpenInactiveProjectItem } from "./use-inactive-project-items";
import * as m from "@/paraglide/messages.js";

/**
 * Search on Home: for the project its row asked for, else for the active
 * project. Opening and closing it change nothing; a result opens like an
 * object of the project on Home.
 */
export function HomeSearch({
  onActivateContent,
}: {
  onActivateContent: () => void;
}) {
  const projectId = useSearchProjectId();
  const activeRootId = useSpace((state) => state.activeRootId);
  const { projects, availability } = useHomeProjects();
  const project = projects.find(
    (candidate) => candidate.id === (projectId ?? activeRootId),
  );
  if (!project) return null;
  return (
    <HomeProjectSearch
      key={project.id}
      project={project}
      availability={availability(project)}
      active={project.id === activeRootId}
      onActivateContent={onActivateContent}
    />
  );
}

/**
 * "Search" of a Home project row. A project of another window opens Search
 * there; any other project opens it here without becoming active.
 */
export function useOpenHomeProjectSearch() {
  const { availability } = useHomeProjects();
  const openProjectSearch = useOpenProjectSearch();
  return useCallback(
    async (project: SpaceInfo) => {
      if (availability(project) === "otherWindow") {
        const handedOff = await sendProjectWindowRequest(project.id, {
          kind: "search",
        }).catch((error: unknown) => {
          console.warn("send_project_window_request failed:", error);
          return false;
        });
        if (handedOff) return;
      }
      openProjectSearch(project.id);
    },
    [availability, openProjectSearch],
  );
}

function HomeProjectSearch({
  project,
  availability,
  active,
  onActivateContent,
}: {
  project: SpaceInfo;
  availability: HomeProjectAvailability;
  active: boolean;
  onActivateContent: () => void;
}) {
  const spaces = useSearchedProjectSpaces(project.path, active);
  const openItem = useOpenInactiveProjectItem(
    project,
    availability,
    onActivateContent,
  );
  const setOpen = useOpenCommandPalette();

  const select = useCallback(
    async (target: SearchNavigationTarget) => {
      const root = await resultSpaceRoot(project, active, target.spaceId);
      if (!root) {
        toast.error(m.search_space_unavailable({ name: target.spaceName }));
        return;
      }
      const exists = await pathExists(`${root}/${target.path}`).catch(
        () => true,
      );
      if (!exists) {
        toast.error(m.search_result_unavailable({ title: target.title }));
        return;
      }
      const item: NavigationResolvedItem = {
        key: artifactNavigationKey("page", target.path, target.spaceId, null),
        title: target.title,
        openPath: target.path,
      };
      if (await openItem(item, null)) setOpen(false);
    },
    [active, openItem, project, setOpen],
  );

  return (
    <CommandPalette
      project={{ path: project.path, name: project.name, spaces }}
      onSelect={select}
    />
  );
}

/**
 * The child Spaces of the searched project: the active project's from its
 * runtime, another project's read from its config when Search opens for it.
 */
function useSearchedProjectSpaces(projectPath: string, active: boolean) {
  const activeSpaces = useSpace((state) => state.spaces);
  const [read, setRead] = useState<SpaceInfo[]>([]);
  useEffect(() => {
    if (active) return;
    let current = true;
    readProjectSpaces(projectPath).then(
      (spaces) => {
        if (current) setRead(spaces);
      },
      (error: unknown) => console.warn("list_spaces failed:", error),
    );
    return () => {
      current = false;
    };
  }, [active, projectPath]);
  return active ? activeSpaces : read;
}

/** The folder of the result's Space, or null when the Space is not ready now. */
async function resultSpaceRoot(
  project: SpaceInfo,
  active: boolean,
  spaceId: string | null,
): Promise<string | null> {
  if (spaceId === null) return project.path;
  const spaces = active
    ? getSpaceSnapshot().spaces
    : await readProjectSpaces(project.path).catch(() => []);
  const space = spaces.find((candidate) => candidate.id === spaceId);
  return space?.status === "ready" ? space.path : null;
}
