import type {
  ChatActionAvailability,
  TerminalActionAvailability,
} from "./interface";

/** Device-local slot of the external terminal last chosen to continue a session. */
export const SESSION_CONTINUATION_PREFERENCE_KEY = "session-continuation";

/** An action of the continuation group that can be the primary one. */
export type SessionContinuation =
  | { kind: "chat"; availability: ChatActionAvailability }
  | { kind: "svode_terminal"; availability: TerminalActionAvailability }
  | { kind: "external_terminal"; appId: string };

/**
 * The primary action of a session's "Open with": the external terminal last
 * chosen from the group while it is still offered, otherwise the other
 * interface of the pair — the Svode terminal for a session shown in the
 * chat, the chat for one shown in its terminal. Choosing the chat or the
 * Svode terminal forgets the external terminal, so the pair is primary again;
 * copying the resume command is never primary. An unavailable pair action
 * stays primary and carries its reason.
 */
export function primaryContinuation({
  shownIn,
  rememberedTerminal,
  chat,
  svodeTerminal,
}: {
  shownIn: "chat" | "terminal";
  /** The remembered external terminal while it is installed and has a cwd. */
  rememberedTerminal: string | null;
  chat: ChatActionAvailability;
  svodeTerminal: TerminalActionAvailability;
}): SessionContinuation {
  if (rememberedTerminal) {
    return { kind: "external_terminal", appId: rememberedTerminal };
  }
  return shownIn === "chat"
    ? { kind: "svode_terminal", availability: svodeTerminal }
    : { kind: "chat", availability: chat };
}
