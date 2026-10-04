import { useState, type ReactNode } from "react";
import { History, Info } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentSessionKeyDto, AgentSessionSnapshotDto } from "../api/chat";
import { useSessionActivity } from "../hooks/use-session-activity";
import {
  useSessionComposer,
  type SendRefusal,
} from "../hooks/use-session-composer";
import { toolCallOf } from "../model/timeline";
import { SessionAgentLabel } from "./agent-button";
import { ChatTimeline } from "./chat-timeline";
import { Composer } from "./composer";
import { PendingCard } from "./pending-card";
import * as m from "@/paraglide/messages.js";

const BOTTOM_ATTRIBUTE = "data-session-chat-bottom";

/**
 * The chat of a session the Svode runtime drives: its timeline and, at the
 * bottom of the surface, the composer or the agent's current request in
 * its place. Leaving the surface never stops the agent.
 */
export function SessionChat({
  sessionId,
  session,
  scopeLabel,
}: {
  /** Catalogue id; the composer draft belongs to it. */
  sessionId: string;
  session: AgentSessionKeyDto;
  /** The Space the session works in; it does not change. */
  scopeLabel: string | null;
}) {
  // The composer keeps focus when the chat replaces a surface that had it,
  // as a new session draft does after its first send; it never takes focus
  // from elsewhere.
  const [autoFocus] = useState(
    () => typeof document !== "undefined" && document.activeElement === document.body,
  );
  const { snapshot, error } = useSessionActivity(session);
  const composer = useSessionComposer(sessionId, session, snapshot);
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
  const canSend =
    snapshot.writer === "acp" && snapshot.connection !== "closed" && !composer.running;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        // Esc stops a running turn anywhere in the session, after menus
        // and comboboxes had their chance to close.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!composer.running) return;
        event.preventDefault();
        composer.stop();
      }}
    >
      <ChatTimeline
        session={session}
        snapshot={snapshot}
        header={<HistoryHeader snapshot={snapshot} />}
      />
      <div
        {...{ [BOTTOM_ATTRIBUTE]: "" }}
        className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-1.5 px-6 pt-2"
      >
        {composer.refusal && <RefusalLine refusal={composer.refusal} />}
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
        ) : (
          <div>
            {composer.draft.notSent && (
              <p className="pb-1 text-xs text-destructive">
                {m.sessions_chat_not_sent()}
              </p>
            )}
            <Composer
              text={composer.draft.text}
              onTextChange={composer.setText}
              onSend={() => void composer.send()}
              onStop={composer.stop}
              running={composer.running}
              cancelling={composer.cancelling}
              sending={composer.sending}
              canSend={canSend}
              placeholder={m.sessions_chat_placeholder_continue()}
              autoFocus={autoFocus || moveFocus}
              controls={<SessionAgentLabel agent={session.agent} />}
            />
          </div>
        )}
        <ComposerFooter>
          {scopeLabel && <span className="truncate">{scopeLabel}</span>}
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

function HistoryHeader({ snapshot }: { snapshot: AgentSessionSnapshotDto }) {
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

function ChatUnavailable() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
      {m.sessions_chat_unavailable()}
    </div>
  );
}
