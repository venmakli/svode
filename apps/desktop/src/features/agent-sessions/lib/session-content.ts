import { isEscapeTaken } from "@/shared/lib/escape-key";
import type { AgentSessionTarget } from "../model";

/** Marks the session content, where keys belong to the terminal, not the host. */
export const AGENT_SESSION_CONTENT_ATTRIBUTE = "data-agent-session-content";

/** Whether an event target lies inside session content, e.g. its terminal. */
export function isInsideAgentSessionContent(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(`[${AGENT_SESSION_CONTENT_ATTRIBUTE}]`) !== null
  );
}

/**
 * Whether something inside the session already took this key: a closing
 * menu, or an open inline search of the composer, which chooses on Enter
 * and closes on Esc.
 */
export function isKeyTaken(event: KeyboardEvent) {
  if (isEscapeTaken(event)) return true;
  return (
    event.target instanceof Element &&
    event.target.closest('[role="combobox"]') !== null
  );
}

/**
 * The React key of a host's session content: its opening when the host
 * tells openings apart, so following a terminal keeps the content mounted;
 * otherwise the target.
 */
export function agentSessionContentKey(
  target: AgentSessionTarget,
  openingKey: number | undefined,
): string {
  return openingKey === undefined
    ? `${target.sessionId}\n${target.launchId ?? ""}`
    : `opening:${openingKey}`;
}
