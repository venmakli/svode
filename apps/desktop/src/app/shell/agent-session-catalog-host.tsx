import {
  requestAgentSessionCatalogFastRefresh,
  useAgentSessionCatalogLifecycle,
  useListedAgentSessions,
} from "@/features/agent-sessions";
import { useTerminalAgentSessionSync } from "@/features/terminal";

/**
 * Runs the project session catalog for the whole shell and feeds its sessions
 * to the terminal panel, so no consumer or the panel owns a list or polling
 * of its own.
 */
export function AgentSessionCatalogHost({
  projectPath,
}: {
  projectPath: string | null;
}) {
  useAgentSessionCatalogLifecycle(projectPath);
  const sessions = useListedAgentSessions();
  useTerminalAgentSessionSync({
    projectPath,
    sessions,
    requestSessionRefresh: requestAgentSessionCatalogFastRefresh,
  });
  return null;
}
