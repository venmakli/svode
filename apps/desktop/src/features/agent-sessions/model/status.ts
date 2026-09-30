import type { AgentSession } from "./types";

/**
 * The value of the collection "Status" property (Stage 10 `01` property
 * map) over the session status vocabulary of `02` C10.
 */
export type AgentSessionStatusValue =
  | "requires_action"
  | "running"
  | "done"
  | "cancelled"
  | "interrupted"
  | "error"
  | "unknown";

export function agentSessionStatusValue(
  session: AgentSession,
): AgentSessionStatusValue {
  const { status } = session;
  if (status.state !== "idle") return status.state;
  switch (status.stopReason) {
    case "cancelled":
    case "interrupted":
    case "error":
      return status.stopReason;
    default:
      return "done";
  }
}

/** A turn runs, blocked on the user or not. */
export function isAgentTurnActive(session: AgentSession): boolean {
  return (
    session.status.state === "running" ||
    session.status.state === "requires_action"
  );
}

/** The turn is blocked on a request to the user. */
export function requiresUserAction(session: AgentSession): boolean {
  return session.status.state === "requires_action";
}
