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

interface DraftEntry {
  raw: string | null;
  draft: ComposerDraft | null;
  inMemory?: boolean;
}

const drafts = new Map<string, DraftEntry>();
const EMPTY_ENTRY: DraftEntry = { raw: null, draft: null };

function draftEntry(key: string): DraftEntry {
  const current = drafts.get(key) ?? EMPTY_ENTRY;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return current;
  }
  if (raw === current.raw) return current;
  let draft: ComposerDraft | null = null;
  try {
    const value = raw === null ? null : JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && Array.isArray((value as ComposerDraft).parts)) {
      draft = value as ComposerDraft;
    }
  } catch {
    // A draft from invalid storage is empty.
  }
  const next = { raw, draft };
  drafts.set(key, next);
  return next;
}

export function readComposerDraft(key: string): ComposerDraft | null {
  return draftEntry(key).draft;
}

/** Changes with draft edits and with each send started from this draft. */
export function composerDraftRevision(key: string): object {
  return draftEntry(key);
}

/** A cleared composer is no longer the request a Svode action put in. */
export function settleDraftMark(draft: ComposerDraft): ComposerDraft {
  return draft.mark && isDraftBlank(draft.parts)
    ? { ...draft, mark: null }
    : draft;
}

export function writeComposerDraft(key: string, draft: ComposerDraft | null) {
  if (draft) draft = settleDraftMark(draft);
  const raw = draft && !isEmptyDraft(draft) ? JSON.stringify(draft) : null;
  const current = draftEntry(key);
  if (current.inMemory ? draft === current.draft : raw === current.raw) return;
  try {
    if (raw === null) {
      window.sessionStorage.removeItem(STORAGE_PREFIX + key);
    } else {
      window.sessionStorage.setItem(STORAGE_PREFIX + key, raw);
    }
    drafts.set(key, { raw, draft: raw === null ? null : draft });
  } catch {
    // A restricted WebView can still keep its draft in memory.
    drafts.set(key, { raw: current.raw, draft: raw === null ? null : draft, inMemory: true });
  }
  for (const listener of draftListeners.get(key) ?? []) listener();
}

export function updateComposerDraft(
  key: string,
  change: Partial<ComposerDraft> | ((draft: ComposerDraft) => ComposerDraft),
) {
  const draft = readComposerDraft(key) ?? { parts: [] };
  writeComposerDraft(key, typeof change === "function" ? change(draft) : { ...draft, ...change });
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
  const waiting = textDuringSend.get(key);
  if (waiting) {
    waiting.push(format);
    return;
  }
  const draft = readComposerDraft(key) ?? { parts: [] };
  writeComposerDraft(key, appendText(draft, format));
}

/**
 * Text typed or dictated while a send is under way, in arrival order.
 * Its spacing is decided after the send clears or restores the draft.
 */
type WaitingText = string | ((before: string) => string);
const textDuringSend = new Map<string, WaitingText[]>();

/** A send of the draft of `key` starts: what is typed meanwhile waits for its end. */
export function beginDraftSend(key: string) {
  drafts.set(key, { ...draftEntry(key) });
  textDuringSend.set(key, []);
}

export function draftSendActive(key: string): boolean {
  return textDuringSend.has(key);
}

/**
 * Text typed in the composer of `key` while it shows a send: it waits for
 * the send's end, or goes after the stored draft's text when the send is
 * already over and the composer does not show it yet.
 */
export function typeDuringSend(key: string, text: string) {
  const waiting = textDuringSend.get(key);
  if (!waiting) {
    appendComposerDraftText(key, () => text);
    return;
  }
  const last = waiting.at(-1);
  if (typeof last === "string") waiting[waiting.length - 1] = last + text;
  else waiting.push(text);
}

/** The send of `key` is over: `draft` with what was typed meanwhile after its text. */
export function endDraftSend(key: string, draft: ComposerDraft): ComposerDraft {
  const waiting = textDuringSend.get(key);
  textDuringSend.delete(key);
  return waiting?.reduce(appendText, draft) ?? draft;
}

/**
 * The first send of the new session draft `from` created the session of
 * draft `to`: what was typed during it goes to the stored draft of `to`.
 */
export function passDraftSend(from: string, to: string) {
  const waiting = textDuringSend.get(from);
  textDuringSend.delete(from);
  if (waiting?.length) updateComposerDraft(to, (draft) => waiting.reduce(appendText, draft));
}

function appendText(draft: ComposerDraft, addition: WaitingText): ComposerDraft {
  const last = draft.parts.at(-1);
  const text = typeof addition === "string" ? addition : addition(last?.type === "text" ? last.text : "");
  return text
    ? { ...draft, parts: normalizeDraftParts([...draft.parts, { type: "text", text }]) }
    : draft;
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
