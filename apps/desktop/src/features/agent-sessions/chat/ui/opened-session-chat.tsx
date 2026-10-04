import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Copy,
  History,
  RotateCw,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import { AgentSignInDialog } from "@/features/settings/agent-sign-in";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { useAgentSessionCatalog } from "../../hooks/use-agent-session-catalog";
import { signInAgent, type AgentSessionKeyDto } from "../api/chat";
import { useSessionOpening } from "../hooks/use-session-opening";
import type { ChatSessionState, ChatUnavailableReason } from "../model/interface";
import { AgentRecovery } from "./agent-button";
import { SessionChat } from "./session-chat";
import * as m from "@/paraglide/messages.js";

/** Built-in agents have their own sign-in command; custom agents do not. */
const CUSTOM_PREFIX = "custom-";

/**
 * An existing session opened in the chat (Stage 10 `04`, opening and
 * continuing): its history without a prompt, then the chat; or why it is
 * not shown and the applicable way on. An agent that cannot open it leaves
 * the session to its terminal (`04`, chat and terminal).
 */
export function OpenedSessionChat({
  sessionId,
  agent,
  scopeLabel,
  canOpenInTerminal,
  onOpenInTerminal,
  onShowTerminal,
  onChatUnavailable,
  onStateChange,
  onCopyResumeCommand,
  onOpenAgentSettings,
}: {
  /** Catalogue id of the session. */
  sessionId: string;
  agent: string;
  scopeLabel: string | null;
  /** The agent continues the session in its terminal. */
  canOpenInTerminal: boolean;
  /** Releases the chat's writer of `session`, if any, then resumes in the terminal. */
  onOpenInTerminal: (session: AgentSessionKeyDto | null) => void;
  /** A Svode terminal drives the session. */
  onShowTerminal: () => void;
  /** The agent cannot open the session in the chat. */
  onChatUnavailable: (reason: ChatUnavailableReason) => void;
  onStateChange?: (state: ChatSessionState | null) => void;
  onCopyResumeCommand: (() => void) | null;
  onOpenAgentSettings?: () => void;
}) {
  const projectPath = useAgentSessionCatalog((state) => state.projectPath);
  const opening = useSessionOpening(projectPath, sessionId);
  const dictionary = useAgentAdapterDictionary();
  const [signIn, setSignIn] = useState<string | null>(null);
  const state = opening.opening;
  const openInTerminal = canOpenInTerminal ? () => onOpenInTerminal(null) : null;
  useEffect(() => {
    if (state.state === "unavailable") {
      onChatUnavailable({ kind: "agent_unavailable", reason: state.reason });
    } else if (state.state === "unsupported") {
      onChatUnavailable({ kind: "unsupported" });
    }
  }, [onChatUnavailable, state]);

  if (state.state === "opened") {
    return (
      <SessionChat
        sessionId={sessionId}
        session={state.session}
        scopeLabel={scopeLabel}
        epoch={state.epoch}
        continuation={{
          liveness: state.liveness,
          attaching: opening.attaching,
          refusal: opening.continueRefusal,
          attach: opening.attach,
          refreshing: opening.refreshing,
          refresh: opening.refresh,
          onCopyResumeCommand,
        }}
        onOpenInTerminal={
          canOpenInTerminal ? () => onOpenInTerminal(state.session) : null
        }
        onStateChange={onStateChange}
      />
    );
  }
  if (state.state === "opening") {
    return (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-4"
        aria-busy="true"
      >
        <p className="text-sm text-muted-foreground">
          {m.sessions_chat_history_loading()}
        </p>
        <Skeleton className="h-6 w-2/3 self-end" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const startSignIn = !agent.startsWith(CUSTOM_PREFIX)
    ? () => {
        void signInAgent(agent)
          .then((terminal) => setSignIn(terminal.ptyId))
          .catch((error: unknown) => {
            toast.error(m.sessions_chat_sign_in_failed(), {
              description: getNativeErrorMessage(error),
            });
          });
      }
    : null;

  let body: ReactNode;
  switch (state.state) {
    case "confirmation_required":
      body = (
        <OpeningState
          icon={<History />}
          title={m.sessions_chat_load_history_title()}
          description={m.sessions_chat_load_history_description()}
        >
          <Button size="sm" disabled={opening.attaching} onClick={opening.loadHistory}>
            <History data-icon="inline-start" />
            {opening.attaching
              ? m.sessions_chat_history_loading()
              : m.sessions_chat_load_history()}
          </Button>
          <TerminalButton onClick={openInTerminal} />
        </OpeningState>
      );
      break;
    case "external_active":
      body = (
        <OpeningState
          icon={<Unplug />}
          title={m.sessions_chat_external_writer_title()}
          description={m.sessions_chat_external_writer_description()}
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!onCopyResumeCommand}
            onClick={() => onCopyResumeCommand?.()}
          >
            <Copy data-icon="inline-start" />
            {m.sessions_action_copy_resume_command()}
          </Button>
        </OpeningState>
      );
      break;
    case "terminal_active":
      body = (
        <OpeningState
          icon={<SquareTerminal />}
          title={m.sessions_chat_terminal_writer_title()}
          description={m.sessions_chat_terminal_writer_description()}
        >
          <Button size="sm" onClick={onShowTerminal}>
            <SquareTerminal data-icon="inline-start" />
            {m.sessions_chat_show_terminal()}
          </Button>
        </OpeningState>
      );
      break;
    case "unsupported":
    case "unavailable":
      // The session goes to its terminal with the reason.
      return null;
    case "auth_required":
      body = (
        <OpeningState icon={<AlertCircle />} title={m.sessions_chat_agent_unavailable_title()}>
          <AgentRecovery
            readiness={{
              state: "checked",
              check: { state: "auth_required", message: state.message },
            }}
            recovery={{
              onSignIn: startSignIn,
              onOpenSettings: () => onOpenAgentSettings?.(),
              onRetry: opening.retry,
            }}
          />
          <TerminalButton onClick={openInTerminal} />
        </OpeningState>
      );
      break;
    case "failed":
      body = (
        <OpeningState
          icon={<AlertCircle />}
          title={m.sessions_chat_open_failed_title()}
          description={state.message}
        >
          <Button size="sm" variant="outline" onClick={opening.retry}>
            <RotateCw data-icon="inline-start" />
            {m.sessions_chat_agent_retry()}
          </Button>
          <TerminalButton onClick={openInTerminal} />
        </OpeningState>
      );
      break;
  }

  return (
    <>
      {body}
      {signIn && (
        <AgentSignInDialog
          agent={dictionary.label(agent)}
          ptyId={signIn}
          onSignedIn={opening.retry}
          onClose={() => {
            setSignIn(null);
            opening.retry();
          }}
        />
      )}
    </>
  );
}

function OpeningState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && (
          <EmptyDescription className="break-words">{description}</EmptyDescription>
        )}
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        {children}
      </EmptyContent>
    </Empty>
  );
}

/** "Open in terminal"; inactive with its reason for an agent without terminal resume. */
function TerminalButton({ onClick }: { onClick: (() => void) | null }) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!onClick}
      title={onClick ? undefined : m.sessions_chat_no_terminal()}
      onClick={() => onClick?.()}
    >
      <SquareTerminal data-icon="inline-start" />
      {m.sessions_action_open_in_terminal()}
    </Button>
  );
}
