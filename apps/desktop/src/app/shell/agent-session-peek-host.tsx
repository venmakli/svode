import { useCallback } from "react";
import {
  AgentSessionPeek,
  useOpenNewSession,
  type AgentSession,
  type AgentSessionScopeGroup,
  type AgentSessionTarget,
  type NewSessionStarted,
} from "@/features/agent-sessions";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";
import { useOpenSessionRoutine } from "./open-session-routine";

/**
 * Makes a session the main area object after the guards of the open peek
 * stack and the main area pass, unless the caller passed them (`guarded`).
 * Returns whether it opened. Focus moves into the main area unless the
 * sidebar opened it.
 */
export function useOpenSessionInMainArea() {
  const showSession = useShowSessionInMainArea();

  return useCallback(
    async (
      sessionTarget: AgentSessionTarget,
      session: AgentSession | null,
      options?: { focus?: boolean; guarded?: boolean },
    ) => {
      const { guarded = false, ...show } = options ?? {};
      if (!guarded && !(await passNavigationGuards())) return false;
      showSession(sessionTarget, sessionSpaceOf(session), show);
      return true;
    },
    [showSession],
  );
}

/**
 * "New session" in a Space as the main area object: a chat draft with focus
 * in its composer, or without a chat agent a managed terminal with focus in
 * it. The guards pass first: a cancelled one opens nothing.
 */
export function useStartSessionInMainArea() {
  const showSession = useShowSessionInMainArea();
  const showDraft = useShowDraftInMainArea();
  const openNewSession = useOpenNewSession();

  return useCallback(
    async (scope: AgentSessionScopeGroup) => {
      if (!(await passNavigationGuards())) return;
      const opening = await openNewSession(scope.path);
      if (!opening) return;
      const space =
        scope.kind === "space" ? { spaceId: scope.scopeId } : { spaceId: null };
      if (opening.kind === "draft") {
        showDraft(opening.draft, space);
      } else {
        showSession(opening.target, space, { focusTerminal: true });
      }
    },
    [openNewSession, showDraft, showSession],
  );
}

/** The first send of a main area draft: the created session replaces it. */
export function useShowStartedSessionInMainArea() {
  const showSession = useShowSessionInMainArea();
  const scopes = useSessionScopesBySpacePath();
  return useCallback(
    (started: NewSessionStarted, spacePath: string) =>
      showSession(
        { sessionId: started.sessionId, launchId: null },
        scopes(spacePath),
      ),
    [scopes, showSession],
  );
}

/** The Space reference of a Space path: a registered Space or the root. */
function useSessionScopesBySpacePath() {
  const spaces = useSpace((state) => state.spaces);
  return useCallback(
    (spacePath: string): SessionSpace => {
      const space = spaces.find((candidate) => candidate.path === spacePath);
      return { spaceId: space?.id ?? null };
    },
    [spaces],
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

function useShowDraftInMainArea() {
  const openSessionDraftMainSurface = useShellStore(
    (state) => state.openSessionDraftMainSurface,
  );
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);
  return useCallback(
    (
      draft: Parameters<typeof openSessionDraftMainSurface>[0],
      space: SessionSpace,
    ) => {
      if (space?.spaceId) {
        void openSpace(space.spaceId);
      } else if (space) {
        clearActiveSpace();
      }
      openSessionDraftMainSurface(draft);
    },
    [clearActiveSpace, openSessionDraftMainSurface, openSpace],
  );
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
  const draft = useShellStore((state) => state.sessionPeekDraft);
  const openSessionPeek = useShellStore((state) => state.openSessionPeek);
  const openAppSettings = useShellStore((state) => state.openAppSettings);
  const focusTerminal = useShellStore(
    (state) => state.sessionPeekFocusTerminal,
  );
  const closeSessionPeek = useShellStore((state) => state.closeSessionPeek);
  const expand = useOpenSessionInMainArea();
  const openSessionRoutine = useOpenSessionRoutine();

  return (
    <AgentSessionPeek
      target={target}
      draft={draft}
      onDraftStarted={(started) =>
        openSessionPeek({ sessionId: started.sessionId, launchId: null })
      }
      onOpenAgentSettings={() => openAppSettings("providers")}
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
 * "New session" in a Space in the session peek over the current context: a
 * chat draft, or without a chat agent a managed terminal.
 */
export function useStartSessionInPeek() {
  const openNewSession = useOpenNewSession();
  const openSessionPeek = useShellStore((state) => state.openSessionPeek);
  const openSessionDraftPeek = useShellStore(
    (state) => state.openSessionDraftPeek,
  );
  return useCallback(
    (spacePath: string) => {
      void openNewSession(spacePath).then((opening) => {
        if (opening?.kind === "draft") openSessionDraftPeek(opening.draft);
        else if (opening) {
          openSessionPeek(opening.target, { focusTerminal: true });
        }
      });
    },
    [openNewSession, openSessionDraftPeek, openSessionPeek],
  );
}
