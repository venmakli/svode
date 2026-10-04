import { useEffect, useState, type ReactNode } from "react";
import { Copy, History, Info, RotateCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  AgentExternalLivenessDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "../api/chat";
import { useSessionActivity } from "../hooks/use-session-activity";
import { useSessionSettings } from "../hooks/use-session-settings";
import {
  useSessionComposer,
  type SendRefusal,
} from "../hooks/use-session-composer";
import type { ContinueRefusal } from "../hooks/use-session-opening";
import { isKeyTaken, takeKey } from "../../lib/session-content";
import { isDraftBlank } from "../model/attachments";
import type { ChatSessionState } from "../model/interface";
import { sessionControls } from "../model/session-controls";
import { toolCallOf } from "../model/timeline";
import { AgentModelButton, unavailableText } from "./agent-button";
import { ChatTimeline } from "./chat-timeline";
import { Composer } from "./composer";
import { PendingCard } from "./pending-card";
import { ContextIndicator, ModeSelect, SettingRefusalLine } from "./session-controls";
import * as m from "@/paraglide/messages.js";

const BOTTOM_ATTRIBUTE = "data-session-chat-bottom";

/** Continuing a session the chat only read: its first send attaches it. */
export interface ChatContinuation {
  liveness: AgentExternalLivenessDto;
  attaching: boolean;
  refusal: ContinueRefusal | null;
  attach: () => Promise<boolean>;
  /** Reads the history again while another process writes to the session. */
  refresh: () => void;
  refreshing: boolean;
  /** Manual fallback while another process writes to the session. */
  onCopyResumeCommand: (() => void) | null;
}

/**
 * The chat of a session the Svode runtime drives: its timeline and, at the
 * bottom of the surface, the composer or the agent's current request in
 * its place. Leaving the surface never stops the agent.
 */
export function SessionChat({
  sessionId,
  session,
  scopeLabel,
  epoch = 0,
  continuation,
  onOpenInTerminal,
  onStateChange,
}: {
  /** Catalogue id; the composer draft belongs to it. */
  sessionId: string;
  session: AgentSessionKeyDto;
  /** The Space the session works in; it does not change. */
  scopeLabel: string | null;
  /** A new value follows the session anew, as after it was attached again. */
  epoch?: number;
  /** Present for a session opened in the chat rather than created there. */
  continuation?: ChatContinuation;
  /** The full history in the agent's terminal; between turns only. */
  onOpenInTerminal?: (() => void) | null;
  /** Receives the session and its turn while the chat shows it, then null. */
  onStateChange?: (state: ChatSessionState | null) => void;
}) {
  // The composer keeps focus when the chat replaces a surface that had it,
  // as a new session draft does after its first send; it never takes focus
  // from elsewhere.
  const [autoFocus] = useState(
    () => typeof document !== "undefined" && document.activeElement === document.body,
  );
  const { snapshot, error } = useSessionActivity(session, epoch);
  const composer = useSessionComposer(
    sessionId,
    session,
    snapshot,
    continuation?.attach,
  );
  const settings = useSessionSettings(session);
  const [confirming, setConfirming] = useState(false);
  // When the request card replaces the field, or the field comes back,
  // focus follows only if it was in what is being replaced. This is read
  // while the replaced part is still mounted.
  const pendingId = snapshot?.pending?.id ?? null;
  const [focusMove, setFocusMove] = useState({ pendingId, inside: false });
  if (focusMove.pendingId !== pendingId) {
    setFocusMove({
      pendingId,
      inside: Boolean(document.activeElement?.closest(`[${BOTTOM_ATTRIBUTE}]`)),
    });
  }
  const moveFocus = focusMove.inside;

  const shown = snapshot !== null;
  const turnActive = composer.running || pendingId !== null;
  const { agent, namespace, sessionId: keyId } = session;
  useEffect(() => {
    if (!shown) return;
    onStateChange?.({
      session: { agent, namespace, sessionId: keyId },
      turnActive,
    });
  }, [agent, keyId, namespace, onStateChange, shown, turnActive]);
  useEffect(() => () => onStateChange?.(null), [onStateChange]);

  if (!snapshot) {
    return error ? (
      <ChatUnavailable />
    ) : (
      <div className="flex h-full flex-col gap-3 px-6 py-4" aria-busy="true">
        <Skeleton className="h-6 w-2/3 self-end" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const pending = snapshot.pending;
  // A read session is continued by attaching it first (`04`, opening and
  // continuing): at unknown liveness after an inline confirmation, never
  // while another process writes to it.
  const read = snapshot.writer !== "acp" && continuation !== undefined;
  const externalWriter = read && continuation.liveness === "external_active";
  const canSend =
    !composer.running &&
    (read
      ? !externalWriter && !continuation.attaching
      : snapshot.writer === "acp" && snapshot.connection !== "closed");
  // Only the confirmation's own button sends, never a repeated Enter.
  const send = () => {
    if (read && continuation.liveness === "unknown") {
      if (!isDraftBlank(composer.draft.parts)) setConfirming(true);
      return;
    }
    void composer.send();
  };
  const confirmSend = () => {
    setConfirming(false);
    void composer.send();
  };
  const between = !composer.running && !pending;
  // Settings change on the session the runtime drives, also during a turn:
  // the agent applies them to the next one.
  const canChange = snapshot.writer === "acp" && snapshot.connection !== "closed";
  const mode = sessionControls(snapshot.settings).mode;
  const changeSetting = (value: Parameters<typeof settings.change>[0]) =>
    void settings.change(value);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        // Esc stops a running turn anywhere in the session, after menus
        // and comboboxes had their chance to close.
        if (event.key !== "Escape" || isKeyTaken(event.nativeEvent)) return;
        if (!composer.running) return;
        takeKey(event.nativeEvent);
        composer.stop();
      }}
    >
      <ChatTimeline
        session={session}
        snapshot={snapshot}
        header={
          <HistoryHeader
            snapshot={snapshot}
            onOpenInTerminal={onOpenInTerminal}
            canOpenInTerminal={between}
          />
        }
      />
      <div
        {...{ [BOTTOM_ATTRIBUTE]: "" }}
        className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-1.5 px-6 pt-2"
      >
        {composer.refusal && <RefusalLine refusal={composer.refusal} />}
        {settings.refusal && (
          <SettingRefusalLine refusal={settings.refusal} settings={snapshot.settings} />
        )}
        {continuation?.refusal && (
          <ContinueRefusalLine refusal={continuation.refusal} />
        )}
        {confirming && read && !pending && (
          <AttachConfirmation onConfirm={confirmSend} onCancel={() => setConfirming(false)} />
        )}
        {pending ? (
          <PendingCard
            session={session}
            pending={pending}
            toolCall={toolCallOf(snapshot, pending.toolCallId)}
            takeFocus={moveFocus}
            cancelling={composer.cancelling}
            error={composer.answerError}
            onAnswer={(answer) => void composer.answer(pending.id, answer)}
            onStop={composer.stop}
          />
        ) : externalWriter ? (
          <ExternalWriter continuation={continuation} />
        ) : (
          <div>
            {composer.draft.notSent && (
              <p className="pb-1 text-xs text-destructive">
                {m.sessions_chat_not_sent()}
              </p>
            )}
            <Composer
              parts={composer.draft.parts}
              onPartsChange={composer.setParts}
              onSend={send}
              onStop={composer.stop}
              running={composer.running}
              cancelling={composer.cancelling}
              sending={composer.sending || Boolean(continuation?.attaching)}
              canSend={canSend}
              placeholder={m.sessions_chat_placeholder_continue()}
              autoFocus={autoFocus || moveFocus}
              commands={snapshot.commands}
              controls={
                <AgentModelButton
                  agent={session.agent}
                  draft={null}
                  settings={snapshot.settings}
                  canChange={canChange}
                  changing={settings.changing}
                  onChange={changeSetting}
                />
              }
            />
          </div>
        )}
        <ComposerFooter>
          {scopeLabel && <span className="truncate">{scopeLabel}</span>}
          <div className="ms-auto flex min-w-0 items-center gap-1">
            {mode && (
              <ModeSelect
                mode={mode}
                canChange={canChange}
                changing={settings.changing === mode.id}
                onChange={changeSetting}
              />
            )}
            <ContextIndicator usage={snapshot.usage} />
          </div>
        </ComposerFooter>
      </div>
    </div>
  );
}

export function ComposerFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2 px-1 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function HistoryHeader({
  snapshot,
  onOpenInTerminal,
  canOpenInTerminal,
}: {
  snapshot: AgentSessionSnapshotDto;
  onOpenInTerminal?: (() => void) | null;
  canOpenInTerminal: boolean;
}) {
  const { history } = snapshot;
  if (history.truncatedItems) {
    return (
      <Marker variant="border">
        <MarkerIcon>
          <History />
        </MarkerIcon>
        <MarkerContent>
          {m.sessions_chat_history_truncated({
            count: history.truncatedItems,
          })}
        </MarkerContent>
        {onOpenInTerminal && (
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            disabled={!canOpenInTerminal}
            title={canOpenInTerminal ? undefined : m.sessions_chat_terminal_during_turn()}
            onClick={onOpenInTerminal}
          >
            <SquareTerminal data-icon="inline-start" />
            {m.sessions_action_open_in_terminal()}
          </Button>
        )}
      </Marker>
    );
  }
  if (history.available && snapshot.items.length === 0) {
    return (
      <Marker variant="border">
        <MarkerIcon>
          <Info />
        </MarkerIcon>
        <MarkerContent>{m.sessions_chat_history_empty()}</MarkerContent>
      </Marker>
    );
  }
  if (!history.available && history.source === "none") {
    return (
      <Marker variant="border">
        <MarkerIcon>
          <Info />
        </MarkerIcon>
        <MarkerContent>{m.sessions_chat_history_not_provided()}</MarkerContent>
      </Marker>
    );
  }
  return null;
}

function RefusalLine({ refusal }: { refusal: SendRefusal }) {
  let text: string;
  switch (refusal.code) {
    case "turn_active":
      text = m.sessions_chat_refusal_turn_active();
      break;
    case "auth_required":
      text = m.sessions_chat_refusal_auth();
      break;
    case "file_unavailable":
      text = m.sessions_chat_refusal_file_unavailable();
      break;
    case "connection_closed":
    case "connection_not_found":
    case "session_not_found":
    case "writer_required":
      text = m.sessions_chat_refusal_connection();
      break;
    default:
      text = m.sessions_chat_refusal_other({ message: refusal.message });
  }
  return <p className="text-xs break-words text-destructive">{text}</p>;
}

/** Inline confirmation of the first send after reading (C7, one attempt). */
function AttachConfirmation({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={m.sessions_chat_attach_title()}
      className="flex flex-col gap-2 rounded-lg border p-3 text-sm"
    >
      <p>{m.sessions_chat_attach_description()}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {m.project_cancel()}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {m.sessions_chat_attach_confirm()}
        </Button>
      </div>
    </div>
  );
}

/**
 * In place of the composer while another process writes to the session:
 * the timeline is a snapshot of what was read, which "Refresh" reads again
 * (`04`, opening an existing session).
 */
function ExternalWriter({
  continuation: { refresh, refreshing, onCopyResumeCommand },
}: {
  continuation: ChatContinuation;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
      <div className="min-w-0 flex-1">
        <p>{m.sessions_chat_external_writer()}</p>
        <p className="text-xs text-muted-foreground">{m.sessions_chat_snapshot()}</p>
      </div>
      <Button size="sm" variant="outline" disabled={refreshing} onClick={refresh}>
        <RotateCw data-icon="inline-start" />
        {refreshing
          ? m.sessions_chat_snapshot_refreshing()
          : m.sessions_chat_snapshot_refresh()}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!onCopyResumeCommand}
        onClick={() => onCopyResumeCommand?.()}
      >
        <Copy data-icon="inline-start" />
        {m.sessions_action_copy_resume_command()}
      </Button>
    </div>
  );
}

function ContinueRefusalLine({ refusal }: { refusal: ContinueRefusal }) {
  const text =
    refusal.outcome === "unavailable"
      ? unavailableText(refusal.reason)
      : refusal.outcome === "auth_required"
        ? m.sessions_chat_refusal_auth()
        : m.sessions_chat_refusal_other({ message: refusal.message });
  return <p className="text-xs break-words text-destructive">{text}</p>;
}

function ChatUnavailable() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
      {m.sessions_chat_unavailable()}
    </div>
  );
}
