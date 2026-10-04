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
 * Esc events the host kept for the session content. A Radix host prevents
 * the default of every Esc it does not close on, before React handlers run,
 * so the session tells such an Esc from one a menu inside it already took.
 */
const keptEscapes = new WeakSet<Event>();

/** Keeps the host open on an Esc inside session content; the session still owns the key. */
export function keepEscapeForSession(event: KeyboardEvent) {
  event.preventDefault();
  keptEscapes.add(event);
}

/**
 * Whether something inside the session already took this key: a closing
 * menu, or an open inline search of the composer, which chooses on Enter
 * and closes on Esc.
 */
export function isKeyTaken(event: KeyboardEvent) {
  if (event.defaultPrevented && !keptEscapes.has(event)) return true;
  return (
    event.target instanceof Element &&
    event.target.closest('[role="combobox"]') !== null
  );
}

/** Takes the key for the session so handlers further out leave it. */
export function takeKey(event: KeyboardEvent) {
  event.preventDefault();
  keptEscapes.delete(event);
}
