import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DraftSpaceChoices } from "@/features/agent-sessions";
import {
  HomeChatUnavailable,
  homeProjectUnavailableReason,
  useHomeProjects,
  useProjectWindowsLifecycle,
} from "@/features/home";
import {
  getSpaceSnapshot,
  useSpace,
  useSpaceActions,
  type SpaceInfo,
} from "@/features/space";
import { listenProjectWindowRequest } from "@/platform/space/space-api";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";

/**
 * A new chat with the active project's root as the main area object; focus
 * goes to its composer.
 */
function useShowProjectChat() {
  const openSessionDraftMainSurface = useShellStore(
    (state) => state.openSessionDraftMainSurface,
  );
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);
  return useCallback(() => {
    const projectPath = getSpaceSnapshot().activeRootPath;
    if (!projectPath) return;
    clearActiveSpace();
    openSessionDraftMainSurface({
      draftId: crypto.randomUUID(),
      spacePath: projectPath,
    });
  }, [clearActiveSpace, openSessionDraftMainSurface]);
}

/**
 * Entering Home shows a new chat with the active project; without one Home
 * takes the first project it can work with.
 */
export function HomeEntry() {
  useProjectWindowsLifecycle();
  const activeRootId = useSpace((state) => state.activeRootId);
  const { firstAvailable, loaded } = useHomeProjects();
  const { activateHomeRoot } = useSpaceActions();
  const showProjectChat = useShowProjectChat();
  const entered = useRef(false);
  const activating = useRef(false);

  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    showProjectChat();
  }, [showProjectChat]);

  useEffect(() => {
    if (activeRootId || !loaded || !firstAvailable || activating.current) {
      return;
    }
    activating.current = true;
    void activateHomeRoot(firstAvailable.id, { kind: "focus" }).then(
      (entry) => {
        activating.current = false;
        if (entry === "opened") showProjectChat();
      },
    );
  }, [activateHomeRoot, activeRootId, firstAvailable, loaded, showProjectChat]);

  return null;
}

/**
 * "Start chat" of a Home project: after the guards the project becomes
 * active and a new chat with it opens; a project of another window takes
 * the chat there.
 */
export function useStartHomeChat() {
  const { availability } = useHomeProjects();
  const { activateHomeRoot } = useSpaceActions();
  const showProjectChat = useShowProjectChat();
  return useCallback(
    async (project: SpaceInfo) => {
      const elsewhere = availability(project) === "otherWindow";
      if (!elsewhere && !(await passNavigationGuards())) return;
      const entry = await activateHomeRoot(project.id, { kind: "newChat" });
      if (entry === "opened") showProjectChat();
    },
    [activateHomeRoot, availability, showProjectChat],
  );
}

/**
 * The projects the composer of a Home chat lists; choosing one makes it the
 * active project after the guards.
 */
export function useHomeDraftSpaceChoices(): DraftSpaceChoices {
  const { projects, availability } = useHomeProjects();
  const { activateHomeRoot } = useSpaceActions();
  return useMemo(
    () => ({
      choices: projects.map((project) => ({
        path: project.path,
        name: project.name,
        icon: project.icon || null,
        kind: "project",
        unavailable: homeProjectUnavailableReason(availability(project)),
      })),
      choose: async (path: string) => {
        const project = projects.find((candidate) => candidate.path === path);
        if (!project) return false;
        if (project.id === getSpaceSnapshot().activeRootId) return true;
        if (!(await passNavigationGuards())) return false;
        return (
          (await activateHomeRoot(project.id, { kind: "newChat" })) === "opened"
        );
      },
    }),
    [activateHomeRoot, availability, projects],
  );
}

/**
 * The main area of Home without an active project: nothing while Home takes
 * one, otherwise why no project can take a chat.
 */
export function HomeMainPlaceholder() {
  const { firstAvailable, loaded } = useHomeProjects();
  if (!loaded || firstAvailable) return null;
  return <HomeChatUnavailable />;
}

/**
 * A chat another window started for this window's project opens here after
 * this window's guards.
 */
export function useProjectWindowRequests() {
  const showProjectChat = useShowProjectChat();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenProjectWindowRequest((request) => {
      if (request.kind !== "newChat") return;
      void passNavigationGuards().then((passed) => {
        if (passed) showProjectChat();
      });
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((err) =>
        console.warn("listen app-windows:project-request failed:", err),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showProjectChat]);
}
