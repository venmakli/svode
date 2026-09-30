import { useCallback } from "react";
import {
  AgentSessionPeek,
  useStartAgentSession,
  type AgentSession,
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
  const openSessionMainSurface = useShellStore(
    (state) => state.openSessionMainSurface,
  );
  const detailController = useCollectionDetailController();
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);

  return useCallback(
    async (
      sessionTarget: AgentSessionTarget,
      session: AgentSession | null,
      options?: { focus?: boolean },
    ) => {
      if (!(await detailController.prepareForNavigation())) return false;
      if ((await prepareActiveContentDeactivation()) === "blocked")
        return false;
      // Git sync and changes of the window header follow the session's Space.
      if (session?.scopeKind === "space" && session.spaceId) {
        void openSpace(session.spaceId);
      } else if (session?.scopeKind === "project") {
        clearActiveSpace();
      }
      openSessionMainSurface(sessionTarget, options);
      return true;
    },
    [clearActiveSpace, detailController, openSessionMainSurface, openSpace],
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
