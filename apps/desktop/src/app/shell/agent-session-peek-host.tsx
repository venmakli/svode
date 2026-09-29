import { useCallback } from "react";
import {
  AgentSessionPeek,
  type AgentSession,
  type AgentSessionTarget,
} from "@/features/agent-sessions";
import { prepareActiveContentDeactivation } from "@/features/artifact";
import { useCollectionDetailController } from "@/features/collection/app-shell";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";

/**
 * The session peek of the shell. "Expand" makes the session the main area
 * object after the guards of the open peek stack and the main area pass.
 */
export function AgentSessionPeekHost() {
  const target = useShellStore((state) => state.sessionPeekTarget);
  const closeSessionPeek = useShellStore((state) => state.closeSessionPeek);
  const openSessionMainSurface = useShellStore(
    (state) => state.openSessionMainSurface,
  );
  const detailController = useCollectionDetailController();
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);

  const expand = useCallback(
    async (sessionTarget: AgentSessionTarget, session: AgentSession | null) => {
      if (!(await detailController.prepareForNavigation())) return false;
      if ((await prepareActiveContentDeactivation()) === "blocked")
        return false;
      // Git sync and changes of the window header follow the session's Space.
      if (session?.scopeKind === "space" && session.spaceId) {
        void openSpace(session.spaceId);
      } else if (session?.scopeKind === "project") {
        clearActiveSpace();
      }
      openSessionMainSurface(sessionTarget);
      return true;
    },
    [clearActiveSpace, detailController, openSessionMainSurface, openSpace],
  );

  return (
    <AgentSessionPeek
      target={target}
      onOpenChange={(open) => {
        if (!open) closeSessionPeek();
      }}
      onExpand={expand}
    />
  );
}
