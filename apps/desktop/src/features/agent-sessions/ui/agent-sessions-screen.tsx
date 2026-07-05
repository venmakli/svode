import { useMemo, useState } from "react";
import {
  Copy,
  ExternalLink,
  FileSearch,
  Info,
  MoreVertical,
  PanelRight,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSpace } from "@/features/space";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { useAgentSessions } from "../hooks";
import {
  commandDisplay,
  scopeLabel,
  sessionTimeLabel,
  sourceLabel,
} from "../lib";
import type { AgentSession } from "../api";
import { SessionsList } from "./sessions-list";
import { SessionTerminalPane } from "./session-terminal-pane";
import { statusLabel } from "./session-status";
import * as m from "@/paraglide/messages.js";

interface AgentSessionsScreenProps {
  onOpenAppSettings?: () => void;
}

export function AgentSessionsScreen({
  onOpenAppSettings,
}: AgentSessionsScreenProps) {
  const { activeRootIcon, activeRootName, activeRootPath, spaces } = useSpace();
  const sessions = useAgentSessions(activeRootPath);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(true);
  const spaceNames = useMemo(() => {
    const names = new Map<string, string>();
    spaces.forEach((space) => {
      names.set(space.id, space.name);
      names.set(space.path, space.name);
    });
    return names;
  }, [spaces]);
  const spaceIcons = useMemo(() => {
    const icons = new Map<string, string>();
    spaces.forEach((space) => {
      icons.set(space.id, space.icon);
      icons.set(space.path, space.icon);
    });
    return icons;
  }, [spaces]);

  async function runAction(action: () => Promise<void>, errorMessage: string) {
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage, {
        description: getNativeErrorMessage(error),
      });
    }
  }

  function copySelectedCommand() {
    const command =
      sessions.selectedReentryResult?.command?.display ??
      (sessions.selectedSession
        ? commandDisplay(sessions.selectedSession)
        : null);
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

  function openSelectedExternalTerminal() {
    void runAction(
      sessions.openSelectedExternalTerminal,
      m.sessions_toast_external_terminal_failed(),
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AgentSessionsHeader
        session={sessions.selectedSession}
        ptyId={sessions.selectedPtyId}
        rootName={activeRootName}
        spaceNames={spaceNames}
        metadataOpen={metadataOpen}
        sessionsSidebarOpen={sessionsSidebarOpen}
        onToggleMetadata={() => setMetadataOpen((open) => !open)}
        onToggleSessionsSidebar={() => setSessionsSidebarOpen((open) => !open)}
        onCopyCommand={copySelectedCommand}
        onCloseTerminal={() =>
          void runAction(
            sessions.closeSelectedTerminal,
            m.sessions_toast_close_terminal_failed(),
          )
        }
        onOpenExternalTerminal={openSelectedExternalTerminal}
        onRevealFile={() =>
          void runAction(
            sessions.revealSelectedSourceFile,
            m.sessions_toast_reveal_failed(),
          )
        }
      />
      <div className="flex min-h-0 flex-1 pb-2">
        <SessionTerminalPane
          controller={sessions}
          rootName={activeRootName}
          spaceNames={spaceNames}
          metadataOpen={metadataOpen}
          onCopyCommand={copySelectedCommand}
          onOpenExternalTerminal={openSelectedExternalTerminal}
        />
        {sessionsSidebarOpen && (
          <SessionsList
            controller={sessions}
            rootIcon={activeRootIcon}
            rootName={activeRootName}
            spaceIcons={spaceIcons}
            spaceNames={spaceNames}
            onOpenAppSettings={onOpenAppSettings}
          />
        )}
      </div>
    </div>
  );
}

function AgentSessionsHeader({
  session,
  ptyId,
  rootName,
  spaceNames,
  metadataOpen,
  sessionsSidebarOpen,
  onToggleMetadata,
  onToggleSessionsSidebar,
  onCopyCommand,
  onCloseTerminal,
  onOpenExternalTerminal,
  onRevealFile,
}: {
  session: AgentSession | null;
  ptyId: string | null;
  rootName: string | null;
  spaceNames: Map<string, string>;
  metadataOpen: boolean;
  sessionsSidebarOpen: boolean;
  onToggleMetadata: () => void;
  onToggleSessionsSidebar: () => void;
  onCopyCommand: () => void;
  onCloseTerminal: () => void;
  onOpenExternalTerminal: () => void;
  onRevealFile: () => void;
}) {
  const { state } = useSidebar();
  const sidebarHidden = state === "collapsed";

  return (
    <header
      data-tauri-drag-region
      style={
        sidebarHidden
          ? { paddingLeft: "calc(var(--shell-chrome-width, 220px) - 1rem)" }
          : undefined
      }
      className="flex h-[44px] shrink-0 items-center gap-3 border-b border-transparent px-4"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {session?.title ?? m.sessions_title()}
        </div>
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {session && (
          <div className="hidden max-w-[min(52vw,720px)] truncate text-xs text-muted-foreground sm:block">
            {statusLabel(session)} · {sourceLabel(session.source)} ·{" "}
            {scopeLabel(session, rootName, spaceNames)} ·{" "}
            {sessionTimeLabel(session)}
          </div>
        )}
        {(session || ptyId) && (
          <SessionActionsMenu
            session={session}
            ptyId={ptyId}
            metadataOpen={metadataOpen}
            onToggleMetadata={onToggleMetadata}
            onCopyCommand={onCopyCommand}
            onCloseTerminal={onCloseTerminal}
            onOpenExternalTerminal={onOpenExternalTerminal}
            onRevealFile={onRevealFile}
          />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={sessionsSidebarOpen ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={
                sessionsSidebarOpen
                  ? m.sessions_action_hide_sidebar()
                  : m.sessions_action_show_sidebar()
              }
              aria-pressed={sessionsSidebarOpen}
              onClick={onToggleSessionsSidebar}
            >
              <PanelRight />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {sessionsSidebarOpen
              ? m.sessions_action_hide_sidebar()
              : m.sessions_action_show_sidebar()}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function SessionActionsMenu({
  session,
  ptyId,
  metadataOpen,
  onToggleMetadata,
  onCopyCommand,
  onCloseTerminal,
  onOpenExternalTerminal,
  onRevealFile,
}: {
  session: AgentSession | null;
  ptyId: string | null;
  metadataOpen: boolean;
  onToggleMetadata: () => void;
  onCopyCommand: () => void;
  onCloseTerminal: () => void;
  onOpenExternalTerminal: () => void;
  onRevealFile: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.sessions_action_more()}
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          {ptyId && (
            <DropdownMenuItem onSelect={onCloseTerminal}>
              <X />
              {m.sessions_action_close_terminal()}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!session?.resumeCommand}
            onSelect={onCopyCommand}
          >
            <Copy />
            {m.sessions_action_copy_resume_command()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!session?.resumeCommand?.cwd && !session?.cwd}
            onSelect={onOpenExternalTerminal}
          >
            <ExternalLink />
            {m.sessions_action_open_external_terminal()}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!session} onSelect={onToggleMetadata}>
            <Info />
            {metadataOpen
              ? m.sessions_action_hide_metadata()
              : m.sessions_action_view_metadata()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={
              !session?.sourceFile || !session?.capabilities.canRevealFile
            }
            onSelect={onRevealFile}
          >
            <FileSearch />
            {m.sessions_action_reveal_file()}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
