import { useEffect } from "react";
import {
  requestAgentSessionCatalogFastRefresh,
  subscribeAgentSessionTerminalFollow,
  useAgentSessionCatalogLifecycle,
  useListedAgentSessions,
} from "@/features/agent-sessions";
import { useTerminalAgentSessionSync } from "@/features/terminal";
import { useShellStore } from "./model";

/**
 * Runs the project session catalog for the whole shell and feeds its sessions
 * to the terminal panel, so no consumer or the panel owns a list or polling
 * of its own. The main area and the peek follow a terminal whose agent went
 * on to another session.
 */
export function AgentSessionCatalogHost({
  projectPath,
}: {
  projectPath: string | null;
}) {
  useAgentSessionCatalogLifecycle(projectPath);
  useEffect(
    () =>
      subscribeAgentSessionTerminalFollow((follow) =>
        useShellStore.getState().followSessionTerminal(follow),
      ),
    [],
  );
  const sessions = useListedAgentSessions();
  useTerminalAgentSessionSync({
    projectPath,
    sessions,
    requestSessionRefresh: requestAgentSessionCatalogFastRefresh,
  });
  return null;
}
