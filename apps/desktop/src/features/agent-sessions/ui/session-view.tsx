import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  BotMessageSquare,
  ListChecks,
  MoreHorizontal,
  SquareTerminal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { AgentIcon } from "@/features/agent-adapters";
import type { OpenWithGroup } from "@/features/external-open";
import {
  useRoutineLaunchLinks,
  type RoutineLaunchLink,
  type RoutineRunLaunch,
} from "@/features/routines/catalog";
import { useSpace } from "@/features/space";
import {
  ManagedTerminalSurface,
  usePanelTerminal,
} from "@/features/terminal/session-surface";
import { getNativeErrorMessage } from "@/platform/native/errors";
import {
  useAgentSessionCatalog,
  useAgentSessionView,
  type AgentSessionView,
} from "../hooks";
import { useSessionContinuationGroup } from "../hooks/use-session-continuation-group";
import { scopeLabel } from "../lib";
import type { AgentSession, AgentSessionTarget } from "../model";
import { ExternalTerminalAppProvider } from "./external-terminal-icon";
import {
  ReentryErrorState,
  SessionMetadataPopover,
  SessionMissingState,
  SessionResumingState,
} from "./session-states";
import { SessionCwdContext } from "../chat/hooks/use-path-base";
import { SessionChat } from "../chat/ui/session-chat";
import { OpenedSessionChat } from "../chat/ui/opened-session-chat";
import { ChatUnavailableLine } from "../chat/ui/chat-unavailable-line";
import { RoutineTerminalLine } from "./routine-terminal-line";
import { releaseAgentSession, type AgentSessionKeyDto } from "../chat/api/chat";
import {
  chatInterface,
  openInTerminalAvailability,
  sessionInterfaceAtOpen,
  type ChatSessionState,
  type ChatUnavailableReason,
  type SessionInterface,
} from "../chat/model/interface";
import { AGENT_SESSION_CONTENT_ATTRIBUTE } from "../lib/session-content";
import * as m from "@/paraglide/messages.js";

/** What the top bar of the main area or the peek shows of a session. */
export interface AgentSessionChrome {
  view: AgentSessionView;
  /** Agent icon and title; null while the session is being checked. */
  identity: { icon: ReactNode; title: string } | null;
  /** "status · time", which opens the session metadata; null without a session. */
  status: ReactNode;
  /** The ⋯ menu of the session; null when it has no actions. */
  menu: ReactNode;
  /** The continuation group of "Open with"; null without a session. */
  openWith: OpenWithGroup | null;
}

interface AgentSessionContentProps {
  target: AgentSessionTarget;
  /** Focus the terminal once it is shown, as after starting a new session. */
  focusTerminal?: boolean;
  /** The top bar of the host, which shows the session identity and menu. */
  renderChrome: (chrome: AgentSessionChrome) => ReactNode;
  onOpenRoutine(routine: RoutineLaunchLink): void;
  /** Recovery of an agent the chat cannot start: the agent settings. */
  onOpenAgentSettings?: () => void;
}

/**
 * The chat or terminal of one session with its top bar parts, shared by the
 * session peek and the main area. The interface is chosen when the session
 * opens (Stage 10 `04`, chat and terminal); opening it never resumes the
 * agent.
 */
export function AgentSessionContent({
  target,
  focusTerminal,
  renderChrome,
  onOpenRoutine,
  onOpenAgentSettings,
}: AgentSessionContentProps) {
  const view = useAgentSessionView(target, { focusTerminal });
  const routine = useSessionRoutine(view.session);
  // Chosen once the session is known, then changed by the user or by a
  // terminal that starts while it is shown.
  const [chosen, setChosen] = useState<SessionInterface | null>(null);
  const atOpen = sessionInterfaceAtOpen(view.session, view.ptyId);
  if (chosen === null && atOpen !== null) setChosen(atOpen);
  if (view.ptyId && chosen?.kind === "chat") {
    setChosen({ kind: "terminal", chatUnavailable: null });
  }
  const surface = chosen ?? atOpen;
  const [chatState, setChatState] = useState<ChatSessionState | null>(null);
  const showTerminal = useCallback(
    () => setChosen({ kind: "terminal", chatUnavailable: null }),
    [],
  );
  const leaveChat = useCallback(
    (reason: ChatUnavailableReason) =>
      setChosen({ kind: "terminal", chatUnavailable: reason }),
    [],
  );
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const { activeRootName, spaces } = useSpace();
  const spaceNames = useMemo(() => {
    const names = new Map<string, string>();
    spaces.forEach((space) => {
      names.set(space.id, space.name);
      names.set(space.path, space.name);
    });
    return names;
  }, [spaces]);
  const session = view.session;
  const identityLabel = session
    ? scopeLabel(session, activeRootName, spaceNames)
    : null;

  function closeTerminal() {
    void view.closeTerminal().catch((error) => {
      toast.error(m.sessions_toast_close_terminal_failed(), {
        description: getNativeErrorMessage(error),
      });
    });
  }

  function copyResumeCommand() {
    const command = view.resumeCommand;
    if (!command) return;
    void navigator.clipboard
      .writeText(command)
      .then(() => toast.success(m.sessions_toast_command_copied()))
      .catch((error) => {
        toast.error(m.sessions_toast_command_copy_failed(), {
          description: getNativeErrorMessage(error),
        });
      });
  }

  /** Leaves the chat for the terminal; the chat first releases its writer. */
  function openInTerminal(session: AgentSessionKeyDto | null) {
    void (session ? releaseAgentSession(session) : Promise.resolve())
      .then(() => {
        showTerminal();
        view.continueInTerminal();
      })
      .catch((error) => {
        toast.error(m.sessions_toast_open_in_terminal_failed(), {
          description: getNativeErrorMessage(error),
        });
      });
  }

  const inChat = surface?.kind === "chat";
  const terminalAction = openInTerminalAvailability(
    Boolean(session?.capabilities.canResume),
    chatState ? chatState.turnActive : view.agentBusy,
  );

  function openExternalTerminal() {
    void view.openExternalTerminal().catch((error) => {
      toast.error(m.sessions_toast_external_terminal_failed(), {
        description: getNativeErrorMessage(error),
      });
    });
  }

  const openWith = useSessionContinuationGroup({
    session,
    shownIn: inChat ? "chat" : "terminal",
    ptyId: view.ptyId,
    svodeTerminal: terminalAction,
    cwd: view.externalTerminalCwd,
    resumeCommand: view.resumeCommand,
    onOpenInChat: () => {
      if (session) setChosen(chatInterface(session));
    },
    onOpenInSvodeTerminal: () =>
      openInTerminal(chatState?.session ?? session?.runtime?.acpSession ?? null),
    onCopyResumeCommand: copyResumeCommand,
  });

  const menu =
    routine?.definitionPresent || view.ptyId ? (
      <SessionActionsMenu
        onOpenRoutine={
          routine?.definitionPresent ? () => onOpenRoutine(routine) : null
        }
        onCloseTerminal={
          view.ptyId
            ? () => {
                if (view.agentBusy) setConfirmCloseOpen(true);
                else closeTerminal();
              }
            : null
        }
      />
    ) : null;

  return (
    <ExternalTerminalAppProvider>
      <div className="flex h-full min-h-0 flex-col">
        {renderChrome({
          view,
          identity: session
            ? {
                icon: <AgentIcon agent={session.source} />,
                title: session.title,
              }
            : view.checking
              ? null
              : { icon: <BotMessageSquare />, title: m.sessions_peek_title() },
          status: session ? (
            <SessionMetadataPopover
              session={session}
              rootName={activeRootName}
              spaceNames={spaceNames}
            />
          ) : null,
          menu,
          openWith,
        })}
        <div
          {...{ [AGENT_SESSION_CONTENT_ATTRIBUTE]: "" }}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <SessionCwdContext.Provider
            value={view.session?.cwd ?? view.session?.spacePath ?? null}
          >
            <SessionBody
              view={view}
              scopeLabel={identityLabel}
              surface={surface}
              routineLaunch={routine?.launch ?? null}
              onCopyCommand={copyResumeCommand}
              onOpenExternalTerminal={openExternalTerminal}
              onOpenInTerminal={openInTerminal}
              onShowTerminal={showTerminal}
              onChatUnavailable={leaveChat}
              onChatStateChange={setChatState}
              onOpenAgentSettings={onOpenAgentSettings}
            />
          </SessionCwdContext.Provider>
        </div>
      </div>
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.sessions_close_terminal_confirm_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.sessions_close_terminal_confirm_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={closeTerminal}>
              {m.sessions_action_close_terminal()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ExternalTerminalAppProvider>
  );
}

function SessionBody({
  view,
  scopeLabel: sessionScopeLabel,
  surface,
  routineLaunch,
  onCopyCommand,
  onOpenExternalTerminal,
  onOpenInTerminal,
  onShowTerminal,
  onChatUnavailable,
  onChatStateChange,
  onOpenAgentSettings,
}: {
  view: AgentSessionView;
  scopeLabel: string | null;
  surface: SessionInterface | null;
  /** How the Routine that launched the session started its agent. */
  routineLaunch: RoutineRunLaunch | null;
  onCopyCommand: () => void;
  onOpenExternalTerminal: () => void;
  onOpenInTerminal: (session: AgentSessionKeyDto | null) => void;
  onShowTerminal: () => void;
  onChatUnavailable: (reason: ChatUnavailableReason) => void;
  onChatStateChange: (state: ChatSessionState | null) => void;
  onOpenAgentSettings?: () => void;
}) {
  const session = view.session;
  const panelTerminal = usePanelTerminal(view.ptyId);

  if (view.ptyId && panelTerminal.inPanel) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SquareTerminal />
          </EmptyMedia>
          <EmptyTitle>{m.sessions_terminal_in_panel_title()}</EmptyTitle>
          <EmptyDescription>
            {m.sessions_terminal_in_panel_description()}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={panelTerminal.show}>
            <SquareTerminal data-icon="inline-start" />
            {m.sessions_action_show_in_panel()}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const canResume = Boolean(session?.capabilities.canResume);
  // The chat follows a session the Svode runtime drives; any other session
  // it opens (`04`, opening and continuing). A live Svode terminal keeps the
  // session.
  const acpSession = session?.runtime?.acpSession;
  if (session && surface?.kind === "chat" && surface.followed && acpSession) {
    return (
      <SessionChat
        sessionId={session.id}
        session={acpSession}
        scopeLabel={sessionScopeLabel}
        onOpenInTerminal={canResume ? () => onOpenInTerminal(acpSession) : null}
        onStateChange={onChatStateChange}
      />
    );
  }
  if (session && surface?.kind === "chat" && !view.ptyId) {
    return (
      <OpenedSessionChat
        sessionId={session.id}
        agent={session.source}
        scopeLabel={sessionScopeLabel}
        canOpenInTerminal={canResume}
        onOpenInTerminal={onOpenInTerminal}
        onShowTerminal={onShowTerminal}
        onChatUnavailable={onChatUnavailable}
        onStateChange={onChatStateChange}
        onCopyResumeCommand={view.resumeCommand ? onCopyCommand : null}
        onOpenAgentSettings={onOpenAgentSettings}
      />
    );
  }
  if (view.ptyId) {
    // A Routine's terminal says why it is not the chat while it runs.
    const terminalChoice =
      routineLaunch?.transport === "terminal" && routineLaunch.reason
        ? { reason: routineLaunch.reason, detail: routineLaunch.detail }
        : null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {terminalChoice && (
          <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-1">
            <RoutineTerminalLine {...terminalChoice} />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ManagedTerminalSurface
            ptyId={view.ptyId}
            title={session?.title ?? m.sessions_title()}
            autoFocus={view.focusTerminal}
            containerClassName="pb-0"
          />
        </div>
      </div>
    );
  }
  if (!session && !view.terminalFinished) {
    return view.checking ? null : <SessionMissingState />;
  }
  if (view.reentering) return <SessionResumingState />;
  if (view.reentryResult?.mode === "error") {
    return (
      <ReentryErrorState
        result={view.reentryResult}
        onCopyCommand={onCopyCommand}
        onOpenExternalTerminal={onOpenExternalTerminal}
        onRetry={view.continueInTerminal}
      />
    );
  }

  const canContinue = canResume;
  const chatUnavailable =
    surface?.kind === "terminal" ? surface.chatUnavailable : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {chatUnavailable && session && (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-1">
          <ChatUnavailableLine
            agent={session.source}
            reason={chatUnavailable}
            onOpenAgentSettings={onOpenAgentSettings}
          />
        </div>
      )}
      <Empty className="min-h-0 flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SquareTerminal />
          </EmptyMedia>
          <EmptyTitle>
            {view.terminalFinished
              ? m.sessions_terminal_finished_title()
              : m.sessions_terminal_closed_title()}
          </EmptyTitle>
          <EmptyDescription>
            {canContinue
              ? m.sessions_continue_description()
              : m.sessions_continue_unavailable_description()}
          </EmptyDescription>
        </EmptyHeader>
        {canContinue && (
          <EmptyContent>
            <Button size="sm" onClick={view.continueInTerminal}>
              <SquareTerminal data-icon="inline-start" />
              {m.sessions_action_continue_in_terminal()}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

/** The Routine that launched a session, read from the Routines owner. */
function useSessionRoutine(session: AgentSession | null) {
  const projectPath = useAgentSessionCatalog((state) => state.projectPath);
  const sessions = useMemo(() => (session ? [session] : []), [session]);
  const routineOf = useRoutineLaunchLinks(projectPath, sessions);
  return session ? routineOf(session) : null;
}

/** The ⋯ menu of a session: its Routine and closing its terminal. */
function SessionActionsMenu({
  onOpenRoutine,
  onCloseTerminal,
}: {
  /** Present when a Routine launched the session and still exists. */
  onOpenRoutine: (() => void) | null;
  /** Present while a Svode terminal runs the session. */
  onCloseTerminal: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.sessions_action_more()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {onOpenRoutine && (
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={onOpenRoutine}>
              <ListChecks />
              {m.sessions_action_open_routine()}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}
        {onOpenRoutine && onCloseTerminal && <DropdownMenuSeparator />}
        {onCloseTerminal && (
          <DropdownMenuItem variant="destructive" onSelect={onCloseTerminal}>
            <X />
            {m.sessions_action_close_terminal()}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
