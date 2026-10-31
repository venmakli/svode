import type { AgentTurnMarkDto } from "@/platform/agent-runtime/agent-runtime-api";

/**
 * A request Svode composes for an agent that commits itself, such as
 * «Зафиксировать с агентом» (Stage 11 1.G) and «Разрешить с агентом»
 * (1.F). It goes into a chat composer as a draft the user edits and sends;
 * the draft carries `mark`, so Svode does not wrap the turn in a version
 * (1.E «Ходы агентов», п. 5).
 */
export interface AgentRequest {
  /** The Space, or the project root, a new chat session starts in. */
  spacePath: string;
  /**
   * In the window of a chat session: the session whose composer takes the
   * request after its typed text. Otherwise a new chat session opens.
   */
  sessionId?: string | null;
  text: string;
  mark: AgentTurnMarkDto;
}

/** Where a request can go: the composer of a session or a new one. */
export type AgentRequestPlace = Pick<AgentRequest, "spacePath" | "sessionId">;

/**
 * The chat sessions that take requests; the app shell owns opening a new
 * session and the composers.
 */
export interface AgentRequests {
  /** Whether a chat session can take a request for `place` now. */
  available: (place: AgentRequestPlace) => Promise<boolean>;
  /**
   * Puts the request into the composer with focus in it; resolves whether
   * it was put. Nothing is sent.
   */
  submit: (request: AgentRequest) => Promise<boolean>;
}

let requests: AgentRequests | null = null;

/** The app shell takes requests for agents into chat sessions. */
export function registerAgentRequests(next: AgentRequests) {
  requests = next;
  return () => {
    if (requests === next) requests = null;
  };
}

/** The chat sessions taking requests, when the app shell has registered them. */
export function agentRequests(): AgentRequests | null {
  return requests;
}
