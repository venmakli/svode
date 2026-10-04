import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Copy,
  Info,
  ListChecks,
  MessagesSquare,
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import { NavigationMenuItems } from "@/features/navigation";
import {
  useRoutineLaunchLinks,
  type RoutineLaunchLink,
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
import { scopeLabel, sessionTimeLabel, tooltipDateTime } from "../lib";
import {
  pinnableAgentSessionItem,
  type AgentSession,
  type AgentSessionTarget,
} from "../model";
import {
  ExternalTerminalAppProvider,
  ExternalTerminalIcon,
} from "./external-terminal-icon";
import {
  ReentryErrorState,
  SessionMetadata,
  SessionMissingState,
  SessionResumingState,
} from "./session-states";
import { SessionStatusMarker, statusText } from "./session-status";
import { SessionChat } from "../chat/ui/session-chat";
import { OpenedSessionChat } from "../chat/ui/opened-session-chat";
import { ChatUnavailableLine } from "../chat/ui/chat-unavailable-line";
import { releaseAgentSession, type AgentSessionKeyDto } from "../chat/api/chat";
import {
  chatInterface,
  openInTerminalAvailability,
  sessionInterfaceAtOpen,
  type ChatSessionState,
  type ChatUnavailableReason,
  type SessionInterface,
  type TerminalActionAvailability,
} from "../chat/model/interface";
import { AGENT_SESSION_CONTENT_ATTRIBUTE } from "../lib/session-content";
import * as m from "@/paraglide/messages.js";

interface AgentSessionContentProps {
  target: AgentSessionTarget;
  /** Focus the terminal once it is shown, as after starting a new session. */
  focusTerminal?: boolean;
  /**
   * Peek chrome: an action row above the identity header that receives the
   * session menu. Without it the menu sits in the identity header.
   */
  renderActions?: (menu: ReactNode, view: AgentSessionView) => ReactNode;
  onOpenRoutine(routine: RoutineLaunchLink): void;
  /** Recovery of an agent the chat cannot start: the agent settings. */
  onOpenAgentSettings?: () => void;
}

/**
 * Identity, status and the chat or terminal of one session, shared by the
 * session peek and the main area. The interface is chosen when the session
 * opens (Stage 10 `04`, chat and terminal); opening it never resumes the
 * agent.
 */
export function AgentSessionContent({
  target,
  focusTerminal,
  renderActions,
  onOpenRoutine,
  onOpenAgentSettings,
}: AgentSessionContentProps) {
  const view = useAgentSessionView(target, { focusTerminal });
  const routine = useSessionRoutine(view.session);
  const [metadataOpen, setMetadataOpen] = useState(false);
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

  const menu = (
    <SessionActionsMenu
      view={view}
      metadataOpen={metadataOpen}
      onToggleMetadata={() => setMetadataOpen((open) => !open)}
      onCloseTerminal={() => {
        if (view.agentBusy) setConfirmCloseOpen(true);
        else closeTerminal();
      }}
      onCopyCommand={copyResumeCommand}
      onOpenExternalTerminal={openExternalTerminal}
      onOpenRoutine={
        routine?.definitionPresent ? () => onOpenRoutine(routine) : null
      }
      onOpenInChat={
        session?.capabilities.canOpenInChat && !inChat
          ? () => setChosen(chatInterface(session))
          : null
      }
      openInTerminal={
        session && inChat
          ? {
              availability: terminalAction,
              onSelect: () =>
                openInTerminal(
                  chatState?.session ?? session.runtime?.acpSession ?? null,
                ),
            }
          : null
      }
    />
  );

  return (
    <ExternalTerminalAppProvider>
      <div className="flex h-full min-h-0 flex-col">
        {renderActions && (
          <div className="flex shrink-0 items-center justify-end gap-1 px-2 pb-2">
            {renderActions(menu, view)}
          </div>
        )}
        <header className="flex shrink-0 items-start gap-3 px-6 pb-3">
          <SessionIdentity
            session={session}
            checking={view.checking}
            identityLabel={identityLabel}
          />
          {!renderActions && menu}
        </header>
        {metadataOpen && session && (
          <SessionMetadata
            session={session}
            rootName={activeRootName}
            spaceNames={spaceNames}
          />
        )}
        <div
          {...{ [AGENT_SESSION_CONTENT_ATTRIBUTE]: "" }}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <SessionBody
            view={view}
            scopeLabel={identityLabel}
            surface={surface}
            onCopyCommand={copyResumeCommand}
            onOpenExternalTerminal={openExternalTerminal}
            onOpenInTerminal={openInTerminal}
            onShowTerminal={showTerminal}
            onChatUnavailable={leaveChat}
            onChatStateChange={setChatState}
            onOpenAgentSettings={onOpenAgentSettings}
          />
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

function SessionIdentity({
  session,
  checking,
  identityLabel,
}: {
  session: AgentSession | null;
  checking: boolean;
  identityLabel: string | null;
}) {
  const agents = useAgentAdapterDictionary();
  if (!session) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {checking ? (
          <>
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </>
        ) : (
          <h2 className="truncate text-lg font-semibold">
            {m.sessions_title()}
          </h2>
        )}
      </div>
    );
  }

  const time = sessionTimeLabel(session);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <h2 className="truncate text-lg font-semibold">{session.title}</h2>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <SessionStatusMarker session={session} />
        <span className="truncate">
          {[statusText(session), agents.label(session.source), identityLabel]
            .filter(Boolean)
            .join(" · ")}
          {time && (
            <>
              {" · "}
              <time
                dateTime={session.lastActivityAt}
                title={tooltipDateTime(session.lastActivityAt) ?? undefined}
              >
                {time}
              </time>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function SessionBody({
  view,
  scopeLabel: sessionScopeLabel,
  surface,
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
    return (
      <ManagedTerminalSurface
        ptyId={view.ptyId}
        title={session?.title ?? m.sessions_title()}
        autoFocus={view.focusTerminal}
        containerClassName="pb-0"
      />
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
  const launchId = session?.launchId ?? null;
  const launchIds = useMemo(() => (launchId ? [launchId] : []), [launchId]);
  const routines = useRoutineLaunchLinks(projectPath, launchIds);
  return launchId ? (routines.get(launchId) ?? null) : null;
}

function SessionActionsMenu({
  view,
  metadataOpen,
  onToggleMetadata,
  onCloseTerminal,
  onCopyCommand,
  onOpenExternalTerminal,
  onOpenRoutine,
  onOpenInChat,
  openInTerminal,
}: {
  view: AgentSessionView;
  metadataOpen: boolean;
  onToggleMetadata: () => void;
  onCloseTerminal: () => void;
  onCopyCommand: () => void;
  onOpenExternalTerminal: () => void;
  /** Present when a Routine launched the session and still exists. */
  onOpenRoutine: (() => void) | null;
  /** Present for a session the agent's runtime can open that the chat does not show. */
  onOpenInChat: (() => void) | null;
  /** Present while the chat shows the session. */
  openInTerminal: {
    availability: TerminalActionAvailability;
    onSelect: () => void;
  } | null;
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
        <DropdownMenuGroup>
          {onOpenInChat && (
            <DropdownMenuItem disabled={Boolean(view.ptyId)} onSelect={onOpenInChat}>
              <MessagesSquare />
              <span className="flex min-w-0 flex-col">
                {m.sessions_action_open_in_chat()}
                {view.ptyId && (
                  <span className="text-xs text-muted-foreground">
                    {m.sessions_open_in_chat_terminal_live()}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          )}
          {openInTerminal && (
            <DropdownMenuItem
              disabled={!openInTerminal.availability.available}
              onSelect={openInTerminal.onSelect}
            >
              <SquareTerminal />
              <span className="flex min-w-0 flex-col">
                {m.sessions_action_open_in_terminal()}
                {!openInTerminal.availability.available && (
                  <span className="text-xs text-muted-foreground">
                    {openInTerminal.availability.reason === "turn_active"
                      ? m.sessions_chat_terminal_during_turn()
                      : m.sessions_chat_no_terminal()}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          )}
          {onOpenRoutine && (
            <DropdownMenuItem onSelect={onOpenRoutine}>
              <ListChecks />
              {m.sessions_action_open_routine()}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!view.resumeCommand}
            onSelect={onCopyCommand}
          >
            <Copy />
            {m.sessions_action_copy_resume_command()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!view.externalTerminalCwd}
            onSelect={onOpenExternalTerminal}
          >
            <ExternalTerminalIcon />
            {m.sessions_action_open_external_terminal()}
          </DropdownMenuItem>
          <NavigationMenuItems item={pinnableAgentSessionItem(view.session)} />
          <DropdownMenuItem
            disabled={!view.session}
            onSelect={onToggleMetadata}
          >
            <Info />
            {metadataOpen
              ? m.sessions_action_hide_metadata()
              : m.sessions_action_view_metadata()}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {view.ptyId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onCloseTerminal}>
              <X />
              {m.sessions_action_close_terminal()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
