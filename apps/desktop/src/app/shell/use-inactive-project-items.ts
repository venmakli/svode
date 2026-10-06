import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  agentSessionTargetFor,
  useSavedProjectSessions,
  type AgentSession,
  type SavedProjectSessions,
} from "@/features/agent-sessions";
import type { HomeProjectAvailability } from "@/features/home";
import {
  useProjectNavigationStore,
  type NavigationKey,
  type NavigationResolvedItem,
  type NavigationStore,
} from "@/features/navigation";
import {
  readProjectSpaces,
  useSpaceActions,
  type SpaceInfo,
} from "@/features/space";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { useOpenSessionInMainArea } from "./agent-session-peek-host";
import { passNavigationGuards } from "./navigation-guards";
import { useOpenNavigationArtifact } from "./navigation-sidebar-items";
import { isSessionKey } from "./now-model";
import * as m from "@/paraglide/messages.js";

/** How often the objects of an expanded project are read while visible. */
const HOME_PROJECT_READ_INTERVAL_MS = 15_000;

const alreadyGuarded = () => Promise.resolve(true);

export interface InactiveProjectItems {
  /** The project's navigation state, read through its Desktop owner. */
  navigation: NavigationStore;
  sessions: SavedProjectSessions;
  /** The Space an artifact or session lives in, as the project names it. */
  spaceName: (spaceId: string | null | undefined) => string | null;
  sessionSpaceName: (session: AgentSession) => string | null;
  /** Reads the navigation state, the sessions and the Spaces again. */
  refresh: () => void;
  /** "Close" of a kept object: it leaves the project's Now. */
  close: (key: NavigationKey) => void;
}

/**
 * The objects of an expanded project that is not the active one, read apart
 * from its runtime: its navigation state, the session lists Desktop holds
 * and its registered Spaces. They are read when it expands, when the window
 * returns to the foreground and periodically while the window is visible.
 */
export function useInactiveProjectItems(
  project: SpaceInfo,
): InactiveProjectItems {
  const navigation = useProjectNavigationStore(project.path);
  const sessions = useSavedProjectSessions(project.path);
  const spaces = useProjectSpaces(project.path);
  const { refresh: refreshSessions } = sessions;
  const { refresh: refreshSpaces } = spaces;

  const refresh = useCallback(() => {
    void navigation.getState().refresh();
    refreshSessions();
    refreshSpaces();
  }, [navigation, refreshSessions, refreshSpaces]);
  useVisibleRefresh(refresh);

  const spaceName = useCallback(
    (spaceId: string | null | undefined) =>
      spaceId
        ? (spaces.list.find((space) => space.id === spaceId)?.name ?? null)
        : project.name,
    [project.name, spaces.list],
  );
  const sessionSpaceName = useCallback(
    (session: AgentSession) =>
      session.scopeKind === "space"
        ? (spaces.list.find(
            (space) =>
              space.id === session.spaceId || space.path === session.spacePath,
          )?.name ?? null)
        : project.name,
    [project.name, spaces.list],
  );
  const close = useCallback(
    (key: NavigationKey) => {
      navigation
        .getState()
        .unkeep([key])
        .catch((error: unknown) => {
          toast.error(m.navigation_close_failed(), {
            description: getNativeErrorMessage(error),
          });
        });
    },
    [navigation],
  );

  return { navigation, sessions, spaceName, sessionSpaceName, refresh, close };
}

/** The registered Spaces of a project, read from its config. */
function useProjectSpaces(projectPath: string) {
  const [list, setList] = useState<SpaceInfo[]>([]);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const current = ++request.current;
    readProjectSpaces(projectPath).then(
      (spaces) => {
        if (current === request.current) setList(spaces);
      },
      (error: unknown) => console.warn("list_spaces failed:", error),
    );
  }, [projectPath]);
  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);
  return { list, refresh };
}

/** Runs `refresh` on a return to the foreground and periodically while visible. */
function useVisibleRefresh(refresh: () => void) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const interval = window.setInterval(
      refreshVisible,
      HOME_PROJECT_READ_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, []);
}

/**
 * Opens an object of a project that is not the active one: after the
 * guards the project becomes active and the object opens in the main area.
 * A project of another window opens it there, after that window's guards.
 */
export function useOpenInactiveProjectItem(
  project: SpaceInfo,
  availability: HomeProjectAvailability,
  onActivateContent: () => void,
) {
  const { activateHomeRoot } = useSpaceActions();
  const openArtifact = useOpenNavigationArtifact({
    onActivateContent,
    onBeforeNavigation: alreadyGuarded,
  });
  const openSession = useOpenSessionInMainArea();

  return useCallback(
    async (item: NavigationResolvedItem, session: AgentSession | null) => {
      const elsewhere = availability === "otherWindow";
      if (!elsewhere && !(await passNavigationGuards())) return;
      const entry = await activateHomeRoot(project.id, {
        kind: "open",
        item: {
          key: item.key,
          title: item.title,
          ...(item.icon ? { icon: item.icon } : {}),
        },
      });
      if (entry !== "opened") return;
      if (!isSessionKey(item.key)) {
        await openArtifact(item);
      } else if (session) {
        await openSession(agentSessionTargetFor(session), session, {
          focus: false,
          guarded: true,
        });
      }
    },
    [activateHomeRoot, availability, openArtifact, openSession, project.id],
  );
}
