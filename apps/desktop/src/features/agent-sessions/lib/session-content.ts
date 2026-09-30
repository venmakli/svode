/** Marks the session content, where keys belong to the terminal, not the host. */
export const AGENT_SESSION_CONTENT_ATTRIBUTE = "data-agent-session-content";

/** Whether an event target lies inside session content, e.g. its terminal. */
export function isInsideAgentSessionContent(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(`[${AGENT_SESSION_CONTENT_ATTRIBUTE}]`) !== null
  );
}
