import { useCallback } from "react";
import {
  AgentSessionPeek,
  useStartAgentSession,
  type AgentSession,
  type AgentSessionScopeGroup,
  type AgentSessionTarget,
} from "@/features/agent-sessions";
import { prepareActiveContentDeactivation } from "@/features/artifact";
import {
  runCollectionNavigation,
  useCollectionDetailController,
} from "@/features/collection/app-shell";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { useOpenSessionRoutine } from "./open-session-routine";

/**
 * Makes a session the main area object after the guards of the open peek
 * stack and the main area pass. Returns whether it opened. Focus moves into
 * the main area unless the sidebar opened it.
 */
export function useOpenSessionInMainArea() {
  const passGuards = useMainAreaGuards();
  const showSession = useShowSessionInMainArea();

  return useCallback(
    async (
      sessionTarget: AgentSessionTarget,
      session: AgentSession | null,
      options?: { focus?: boolean },
    ) => {
      if (!(await passGuards())) return false;
      showSession(sessionTarget, sessionSpaceOf(session), options);
      return true;
    },
    [passGuards, showSession],
  );
}

/**
 * Starts a new session in a Space as the main area object with focus in its
 * terminal. The guards pass first: a cancelled one starts no terminal.
 */
export function useStartSessionInMainArea() {
  const passGuards = useMainAreaGuards();
  const showSession = useShowSessionInMainArea();
  const startSession = useStartAgentSession();

  return useCallback(
    async (scope: AgentSessionScopeGroup) => {
      if (!(await passGuards())) return;
      const target = await startSession(scope.path);
      if (!target) return;
      showSession(
        target,
        scope.kind === "space" ? { spaceId: scope.scopeId } : { spaceId: null },
        { focusTerminal: true },
      );
    },
    [passGuards, showSession, startSession],
  );
}

/** A registered Space by id, null for the project root; unknown if absent. */
type SessionSpace = { spaceId: string | null } | null;

function sessionSpaceOf(session: AgentSession | null): SessionSpace {
  if (session?.scopeKind === "space" && session.spaceId) {
    return { spaceId: session.spaceId };
  }
  return session?.scopeKind === "project" ? { spaceId: null } : null;
}

/** The guards of the open peek stack and the main area object. */
function useMainAreaGuards() {
  const detailController = useCollectionDetailController();
  return useCallback(async () => {
    if (!(await detailController.prepareForNavigation())) return false;
    return (await prepareActiveContentDeactivation()) !== "blocked";
  }, [detailController]);
}

function useShowSessionInMainArea() {
  const openSessionMainSurface = useShellStore(
    (state) => state.openSessionMainSurface,
  );
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);

  return useCallback(
    (
      sessionTarget: AgentSessionTarget,
      space: SessionSpace,
      options?: { focus?: boolean; focusTerminal?: boolean },
    ) => {
      // Git sync and changes of the window header follow the session's Space.
      if (space?.spaceId) {
        void openSpace(space.spaceId);
      } else if (space) {
        clearActiveSpace();
      }
      openSessionMainSurface(sessionTarget, options);
    },
    [clearActiveSpace, openSessionMainSurface, openSpace],
  );
}

/** The session peek of the shell; "Expand" opens it in the main area. */
export function AgentSessionPeekHost() {
  const target = useShellStore((state) => state.sessionPeekTarget);
  const focusTerminal = useShellStore(
    (state) => state.sessionPeekFocusTerminal,
  );
  const closeSessionPeek = useShellStore((state) => state.closeSessionPeek);
  const expand = useOpenSessionInMainArea();
  const openSessionRoutine = useOpenSessionRoutine();

  return (
    <AgentSessionPeek
      target={target}
      focusTerminal={focusTerminal}
      onOpenChange={(open) => {
        if (!open) closeSessionPeek();
      }}
      onExpand={expand}
      onOpenRoutine={openSessionRoutine}
    />
  );
}

/**
 * Starts a new session in a Space and opens it in the session peek. Until the
 * routine detail becomes a peek, an open Drawer closes first; a cancelled
 * guard starts no terminal.
 */
export function useStartSessionInPeek() {
  const startSession = useStartAgentSession();
  const openSessionPeek = useShellStore((state) => state.openSessionPeek);
  const detailController = useCollectionDetailController();
  return useCallback(
    (spacePath: string) => {
      void runCollectionNavigation(detailController, async () => {
        const target = await startSession(spacePath);
        if (target) openSessionPeek(target, { focusTerminal: true });
      });
    },
    [detailController, openSessionPeek, startSession],
  );
}
