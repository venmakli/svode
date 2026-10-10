import { resolveNewSessionTarget, type NewSessionSpaceRef } from "../model";
import { useAgentSessionScopes } from "./use-agent-session-scopes";

/** Where "New session" starts a session for the Space of the main area object. */
export function useNewSessionTarget(space: NewSessionSpaceRef | null) {
  return resolveNewSessionTarget(useAgentSessionScopes(), space);
}
