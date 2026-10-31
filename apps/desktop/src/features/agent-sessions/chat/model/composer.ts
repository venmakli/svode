import type {
  AgentSessionSnapshotDto,
  AgentSettingValueDto,
  AgentTurnMarkDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import {
  isDraftBlank,
  normalizeDraftParts,
  type DraftPart,
} from "./attachments";

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
   * New session drafts: the setting values the agent confirmed in the
   * draft, applied again to a draft session created anew after a reload.
   * Drafts of an existing session the chat has not attached: the values
   * the user chose, which attaching applies before the prompt (DF-171 R3).
   */
  settings?: { agent: string; values: AgentSettingValueDto[] } | null;
  /**
   * A send whose outcome is unknown: the turn id the session had before
   * it. Set while sending, so a reload during the send reconciles too.
   */
  sending?: { previousTurnId: string | null } | null;
  /** The text came back from a send that did not reach the agent. */
  notSent?: boolean;
  /**
   * The draft is a request a Svode action put in, such as «Зафиксировать с
   * агентом» (Stage 11 1.E «Ходы агентов», п. 5): its send carries the mark,
   * and clearing the composer drops it.
   */
  mark?: AgentTurnMarkDto | null;
}

/** The setting values a draft keeps for `agent`. */
export function draftValues(
  draft: ComposerDraft,
  agent: string | null,
): AgentSettingValueDto[] {
  return agent && draft.settings?.agent === agent ? draft.settings.values : [];
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

/** A cleared composer is no longer the request a Svode action put in. */
export function settleDraftMark(draft: ComposerDraft): ComposerDraft {
  return draft.mark && isDraftBlank(draft.parts)
    ? { ...draft, mark: null }
    : draft;
}

export function writeComposerDraft(key: string, draft: ComposerDraft | null) {
  if (draft) draft = settleDraftMark(draft);
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

const draftListeners = new Map<string, Set<() => void>>();

/** Follows changes made to the stored draft of `key` from outside its hook. */
export function subscribeComposerDraft(key: string, listener: () => void) {
  const listeners = draftListeners.get(key) ?? new Set();
  listeners.add(listener);
  draftListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftListeners.delete(key);
  };
}

/**
 * Appends text to the end of the stored draft of `key`, as dictation does
 * when its composer was closed or replaced meanwhile (`06`, stop from
 * outside). `format` gets the text the draft ends with.
 */
export function appendComposerDraftText(
  key: string,
  format: (before: string) => string,
) {
  const draft = readComposerDraft(key) ?? { parts: [] };
  const last = draft.parts.at(-1);
  const text = format(last?.type === "text" ? last.text : "");
  if (!text) return;
  writeComposerDraft(key, {
    ...draft,
    parts: normalizeDraftParts([...draft.parts, { type: "text", text }]),
  });
  for (const listener of draftListeners.get(key) ?? []) listener();
}

/**
 * Puts a request Svode composed after the text of the stored draft of
 * `key`, separated by a blank line, and marks the draft with `mark`; the
 * shown composer of `key` follows. The user edits and sends it.
 */
export function appendComposerDraftRequest(
  key: string,
  text: string,
  mark: AgentTurnMarkDto,
) {
  const request = text.trim();
  if (!request) return;
  const draft = readComposerDraft(key) ?? { parts: [] };
  const last = draft.parts.at(-1);
  const before = last?.type === "text" ? last.text : "";
  const separator = isDraftBlank(draft.parts)
    ? ""
    : before.endsWith("\n\n")
      ? ""
      : before.endsWith("\n")
        ? "\n"
        : "\n\n";
  writeComposerDraft(key, {
    ...draft,
    parts: normalizeDraftParts([
      ...(isDraftBlank(draft.parts) ? [] : draft.parts),
      { type: "text", text: separator + request },
    ]),
    notSent: false,
    mark,
  });
  for (const listener of draftListeners.get(key) ?? []) listener();
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.parts.length === 0 &&
    !draft.agent &&
    !draft.spacePath &&
    !draft.settings?.values.length &&
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
