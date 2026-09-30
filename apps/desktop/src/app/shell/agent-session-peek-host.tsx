import { useCallback } from "react";
import {
  AgentSessionPeek,
  useStartAgentSession,
  type AgentSession,
  type AgentSessionScopeGroup,
  type AgentSessionTarget,
} from "@/features/agent-sessions";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";
import { useOpenSessionRoutine } from "./open-session-routine";

/**
 * Makes a session the main area object after the guards of the open peek
 * stack and the main area pass. Returns whether it opened. Focus moves into
 * the main area unless the sidebar opened it.
 */
export function useOpenSessionInMainArea() {
  const showSession = useShowSessionInMainArea();

  return useCallback(
    async (
      sessionTarget: AgentSessionTarget,
      session: AgentSession | null,
      options?: { focus?: boolean },
    ) => {
      if (!(await passNavigationGuards())) return false;
      showSession(sessionTarget, sessionSpaceOf(session), options);
      return true;
    },
    [showSession],
  );
}

/**
 * Starts a new session in a Space as the main area object with focus in its
 * terminal. The guards pass first: a cancelled one starts no terminal.
 */
export function useStartSessionInMainArea() {
  const showSession = useShowSessionInMainArea();
  const startSession = useStartAgentSession();

  return useCallback(
    async (scope: AgentSessionScopeGroup) => {
      if (!(await passNavigationGuards())) return;
      const target = await startSession(scope.path);
      if (!target) return;
      showSession(
        target,
        scope.kind === "space" ? { spaceId: scope.scopeId } : { spaceId: null },
        { focusTerminal: true },
      );
    },
    [showSession, startSession],
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
 * Starts a new session in a Space and opens it in the session peek over the
 * current context.
 */
export function useStartSessionInPeek() {
  const startSession = useStartAgentSession();
  const openSessionPeek = useShellStore((state) => state.openSessionPeek);
  return useCallback(
    (spacePath: string) => {
      void startSession(spacePath).then((target) => {
        if (target) openSessionPeek(target, { focusTerminal: true });
      });
    },
    [openSessionPeek, startSession],
  );
}
