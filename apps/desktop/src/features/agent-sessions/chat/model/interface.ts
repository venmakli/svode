import type { AgentSession } from "../../model";
import type {
  AgentLaunchUnavailableDto,
  AgentSessionKeyDto,
} from "../api/chat";

/** Why a session is in its terminal rather than the chat. */
export type ChatUnavailableReason =
  /** The record carries no key the agent's runtime opens it under. */
  | { kind: "not_openable" }
  /** The session continues only in the agent's IDE (Stage 10 `07` N6). */
  | { kind: "continues_in_ide" }
  /** The agent neither loads nor resumes the session over its connection. */
  | { kind: "unsupported" }
  /** The agent cannot start now (`03` A1): off, deferred, missing and so on. */
  | { kind: "agent_unavailable"; reason: AgentLaunchUnavailableDto };

export type SessionInterface =
  | { kind: "terminal"; chatUnavailable: ChatUnavailableReason | null }
  /**
   * `followed`: the Svode runtime drives the session, so the chat follows
   * it without opening it.
   */
  | { kind: "chat"; followed: boolean };

/**
 * The interface a session opens in (Stage 10 `04`, chat and terminal): the
 * one of its Svode writer — a live managed terminal or the chat of a
 * runtime connection — otherwise the chat when the agent's runtime can open
 * it, otherwise the terminal with the reason. Null while the session is
 * not known yet. The agent's own readiness is known once the chat opens it.
 */
export function sessionInterfaceAtOpen(
  session: AgentSession | null,
  ptyId: string | null,
): SessionInterface | null {
  if (ptyId) return { kind: "terminal", chatUnavailable: null };
  if (!session) return null;
  return chatInterface(session);
}

/**
 * "Open in chat": the chat of a session without a live managed terminal;
 * a session the chat cannot open stays in its terminal with the reason.
 */
export function chatInterface(session: AgentSession): SessionInterface {
  if (session.runtime?.acpSession) return { kind: "chat", followed: true };
  if (!session.capabilities.canOpenInChat) {
    return {
      kind: "terminal",
      chatUnavailable: session.capabilities.continuesInIde
        ? { kind: "continues_in_ide" }
        : { kind: "not_openable" },
    };
  }
  return { kind: "chat", followed: false };
}

/** What the chat of a session reports to the actions around it. */
export interface ChatSessionState {
  /** The session the chat shows, which "Open in terminal" releases. */
  session: AgentSessionKeyDto;
  /** A turn runs, is being stopped or waits for the user. */
  turnActive: boolean;
}

export type TerminalActionAvailability =
  | { available: true }
  | { available: false; reason: "no_terminal" | "turn_active" };

/**
 * "Open in terminal" from the chat: only for an agent that continues the
 * session in a terminal, and only between turns, so the running process
 * never moves and no second writer appears.
 */
export function openInTerminalAvailability(
  canResume: boolean,
  turnActive: boolean,
): TerminalActionAvailability {
  if (!canResume) return { available: false, reason: "no_terminal" };
  if (turnActive) return { available: false, reason: "turn_active" };
  return { available: true };
}
