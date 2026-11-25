import { signalSessionMessage } from "@/features/navigation";
import {
  agentRuntimeErrorCode,
  promptAgentSession,
  type AgentRuntimeErrorCode,
  type AgentSessionKeyDto,
  type AgentSessionSnapshotDto,
  type AgentSettingValueDto,
} from "../api/chat";
import { createSessionActivity, type SessionActivity } from "../api/session-activity";
import { isDraftBlank, promptParts } from "../model/attachments";
import {
  beginDraftSend,
  draftSendActive,
  draftValues,
  endDraftSend,
  readComposerDraft,
  reconcileUnknownSend,
  updateComposerDraft,
  type ComposerDraft,
} from "../model/composer";
import { attachPlan } from "../model/session-controls";
import { recheckAttachments } from "./use-attachment-preview";
import type { AttachOutcome } from "./use-session-opening";

const RECONCILE_MS = 1500;

export interface SendRefusal {
  code: AgentRuntimeErrorCode | null;
  message: string;
}

interface SendState {
  busy: boolean;
  confirmation: boolean;
  refusal: SendRefusal | null;
}

const IDLE: SendState = { busy: false, confirmation: false, refusal: null };
const states = new Map<string, SendState>();
const listeners = new Map<string, Set<() => void>>();

export function sessionSendState(key: string): SendState {
  return states.get(key) ?? IDLE;
}

export function subscribeSessionSend(key: string, listener: () => void) {
  const subscribed = listeners.get(key) ?? new Set();
  subscribed.add(listener);
  listeners.set(key, subscribed);
  return () => {
    subscribed.delete(listener);
    if (subscribed.size === 0) listeners.delete(key);
  };
}

function setSendState(key: string, state: SendState) {
  if (state === IDLE) states.delete(key);
  else states.set(key, state);
  for (const listener of listeners.get(key) ?? []) listener();
}

export function cancelSendConfirmation(key: string) {
  if (sessionSendState(key).confirmation) setSendState(key, IDLE);
}

export interface SessionSendTarget {
  draftKey: string;
  sessionId: string;
  session: AgentSessionKeyDto;
  activity: SessionActivity | null;
  attach?: (settings: AgentSettingValueDto[], confirmed: boolean) => Promise<AttachOutcome>;
  sessionValues: AgentSettingValueDto[];
}

const shownTargets = new Map<string, Set<SessionSendTarget>>();

export function registerSessionSendTarget(target: SessionSendTarget) {
  const shown = shownTargets.get(target.draftKey) ?? new Set();
  shown.add(target);
  shownTargets.set(target.draftKey, shown);
  return () => {
    shown.delete(target);
    if (shown.size === 0) shownTargets.delete(target.draftKey);
  };
}

function currentTargets(target: SessionSendTarget) {
  const { agent, namespace, sessionId } = target.session;
  return [...(shownTargets.get(target.draftKey) ?? [])].filter(({ session }) =>
    session.agent === agent && session.namespace === namespace && session.sessionId === sessionId,
  );
}

export function canSendToSession(snapshot: AgentSessionSnapshotDto, canAttach: boolean) {
  if (snapshot.pending || snapshot.turn.phase !== "none") return false;
  if (snapshot.writer === "acp") return snapshot.connection !== "closed";
  return snapshot.writer === "none" && canAttach;
}

const refused = (error: unknown): SendRefusal => ({
  code: agentRuntimeErrorCode(error),
  message: errorMessage(error),
});

/**
 * An existing session's send owns its draft and follows activity until the
 * attempt settles, including when the initiating field has disappeared.
 */
export async function sendSessionDraft(
  origin: SessionSendTarget,
  { confirmed = false, dictated = false }: { confirmed?: boolean; dictated?: boolean } = {},
) {
  const target = dictated
    ? currentTargets(origin).at(-1) ?? { ...origin, activity: null }
    : origin;
  const { draftKey, session, attach, sessionValues } = target;
  const draft = readComposerDraft(draftKey);
  if (!draft || isDraftBlank(draft.parts) || draft.sending || draftSendActive(draftKey)) return;
  const confirmation = sessionSendState(draftKey).confirmation;
  const shownWriter = target.activity?.getSnapshot().snapshot?.writer;
  if (confirmation && !confirmed && shownWriter && shownWriter !== "acp") {
    if (dictated) updateComposerDraft(draftKey, { notSent: true });
    return;
  }

  const attempt = startSend(target);
  const unsent = { notSent: dictated || draft.notSent };
  try {
    let snapshot = await readSnapshot(attempt.activity);
    if (confirmation && !confirmed && snapshot?.writer !== "acp") {
      attempt.keep(unsent, { ...IDLE, confirmation: true });
      return;
    }
    if (!snapshot || !canSendToSession(snapshot, Boolean(attach))) {
      attempt.keep(unsent);
      return;
    }
    if (snapshot.writer !== "acp" && attach) {
      const outcome = await attach(attachPlan(sessionValues, draftValues(draft, session.agent)), confirmed);
      if (!outcome.attached) {
        const setting = outcome.refusedSetting;
        attempt.keep({
          ...unsent,
          ...(setting && {
            settings: {
              agent: session.agent,
              values: draftValues(draft, session.agent).filter(
                (value) => value.setting !== setting.setting || value.value !== setting.value,
              ),
            },
          }),
        }, { ...IDLE, confirmation: outcome.confirm });
        return;
      }
      attempt.activity.refresh();
      for (const shown of currentTargets(origin)) {
        if (shown.activity !== attempt.activity) shown.activity?.refresh();
      }
      snapshot = await readSnapshot(attempt.activity);
      if (!snapshot || !canSendToSession(snapshot, false)) {
        attempt.keep(unsent);
        return;
      }
    }

    const previousTurnId = snapshot.turn.turnId;
    updateComposerDraft(draftKey, {
      sending: { previousTurnId },
      notSent: false,
    });
    try {
      await promptAgentSession(session, promptParts(draft.parts), draft.mark);
      attempt.accept();
    } catch (error) {
      const refusal = refused(error);
      if (refusal.code) {
        attempt.keep({ notSent: dictated }, { ...IDLE, refusal });
        if (refusal.code === "file_unavailable") recheckAttachments();
      } else {
        attempt.reconcile(previousTurnId, true);
      }
    }
  } catch (error) {
    attempt.keep({ notSent: dictated }, { ...IDLE, refusal: refused(error) });
  }
}

/** Reconcile a prompt interrupted by a reload, without submitting it again. */
export function resumeSessionSend(target: SessionSendTarget) {
  const sending = readComposerDraft(target.draftKey)?.sending;
  if (!sending || draftSendActive(target.draftKey)) return;
  const attempt = startSend(target);
  attempt.reconcile(sending.previousTurnId);
}

function startSend(target: SessionSendTarget) {
  const { draftKey, sessionId } = target;
  const activity = target.activity ?? createSessionActivity(target.session);
  let settled = false;
  let deadline: number | undefined;
  let check: () => void = () => undefined;
  beginDraftSend(draftKey);
  setSendState(draftKey, { ...IDLE, busy: true });
  const stop = activity.subscribe(() => check());

  const finish = (
    accepted: boolean,
    change: Partial<ComposerDraft> = {},
    state: SendState = IDLE,
  ) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(deadline);
    stop();
    updateComposerDraft(draftKey, (draft) =>
      endDraftSend(
        draftKey,
        accepted ? { parts: [] } : { ...draft, sending: null, ...change },
      ),
    );
    setSendState(draftKey, state);
    if (accepted) signalSessionMessage(sessionId);
  };

  return {
    activity,
    accept: () => finish(true),
    keep: (change: Partial<ComposerDraft>, state?: SendState) => finish(false, change, state),
    reconcile(previousTurnId: string | null, refresh = false) {
      if (settled) return;
      // A fresh snapshot can show the accepted turn even if its delta was lost.
      if (refresh) activity.refresh(true);
      check = () => {
        const { snapshot } = activity.getSnapshot();
        if (snapshot && reconcileUnknownSend(previousTurnId, snapshot) === "accepted") {
          finish(true);
        }
      };
      check();
      if (!settled) deadline = window.setTimeout(() => finish(false, { notSent: true }), RECONCILE_MS);
    },
  };
}

function readSnapshot(activity: SessionActivity): Promise<AgentSessionSnapshotDto | null> {
  const { snapshot, error } = activity.getSnapshot();
  if (snapshot || error) return Promise.resolve(snapshot);
  return new Promise((resolve) => {
    const stop = activity.subscribe(() => {
      const next = activity.getSnapshot();
      if (next.snapshot || next.error) done(next.snapshot);
    });
    const timeout = window.setTimeout(() => done(null), RECONCILE_MS);
    function done(snapshot: AgentSessionSnapshotDto | null) {
      window.clearTimeout(timeout);
      stop();
      resolve(snapshot);
    }
  });
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
