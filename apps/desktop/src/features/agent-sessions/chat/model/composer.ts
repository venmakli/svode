import type { AgentSessionSnapshotDto } from "@/platform/agent-runtime/agent-runtime-api";
import type { DraftPart } from "./attachments";

/**
 * A composer draft (Stage 10 `04`): it survives a window reload and moves
 * between surfaces, but not an app restart, so it lives in the window's
 * session storage and never in the project.
 */
export interface ComposerDraft {
  /** Text and attachment badges in the order they were written. */
  parts: DraftPart[];
  /** New session drafts only: the chosen agent and Space. */
  agent?: string | null;
  spacePath?: string | null;
  /**
   * A send whose outcome is unknown: the turn id the session had before
   * it. Set while sending, so a reload during the send reconciles too.
   */
  sending?: { previousTurnId: string | null } | null;
  /** The text came back from a send that did not reach the agent. */
  notSent?: boolean;
}

const STORAGE_PREFIX = "svode:session-draft:";

/** The draft of an existing session. */
export function sessionDraftKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The draft of a new session started for this Space. */
export function newSessionDraftKey(spacePath: string): string {
  return `new:${spacePath}`;
}

export function readComposerDraft(key: string): ComposerDraft | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const draft = value as ComposerDraft;
    return Array.isArray(draft.parts) ? draft : null;
  } catch {
    return null;
  }
}

export function writeComposerDraft(key: string, draft: ComposerDraft | null) {
  try {
    if (!draft || isEmptyDraft(draft)) {
      window.sessionStorage.removeItem(STORAGE_PREFIX + key);
    } else {
      window.sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(draft));
    }
  } catch {
    // Storage can be unavailable in restricted WebViews; the draft then
    // lives only as long as the surface.
  }
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.parts.length === 0 &&
    !draft.agent &&
    !draft.spacePath &&
    !draft.sending &&
    !draft.notSent
  );
}

export type ComposerKeyAction = "send" | "soft_break" | "stop" | null;

/**
 * What a key does in the composer: Enter sends and Shift+Enter breaks the
 * line, but Enter that ends an IME composition only ends it; Esc stops a
 * running turn.
 */
export function composerKeyAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">,
  turnRunning: boolean,
): ComposerKeyAction {
  if (event.key === "Escape") return turnRunning ? "stop" : null;
  if (event.key !== "Enter") return null;
  // Safari reports the Enter that commits a composition as keyCode 229.
  if (event.isComposing || event.keyCode === 229) return null;
  return event.shiftKey ? "soft_break" : "send";
}

/**
 * The outcome of a send that returned neither a turn id nor a refusal: a
 * new turn in the session means the agent got the message; otherwise the
 * text goes back to the composer marked as not sent. Nothing is resent.
 */
export function reconcileUnknownSend(
  previousTurnId: string | null,
  snapshot: Pick<AgentSessionSnapshotDto, "turn">,
): "accepted" | "not_sent" {
  const turnId = snapshot.turn.turnId;
  return turnId !== null && turnId !== previousTurnId ? "accepted" : "not_sent";
}
