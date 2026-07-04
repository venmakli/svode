import { useState } from "react";
import {
  Copy,
  ExternalLink,
  FileSearch,
  Info,
  MoreHorizontal,
  SquareTerminal,
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ManagedTerminalSurface } from "@/features/terminal/session-surface";
import { getNativeErrorMessage } from "@/platform/native/errors";
import type { useAgentSessions } from "../hooks";
import {
  commandDisplay,
  scopeLabel,
  sessionTimeLabel,
  sourceLabel,
  tooltipDateTime,
} from "../lib";
import type { AgentSession } from "../api";
import { statusLabel } from "./session-status";
import * as m from "@/paraglide/messages.js";

type AgentSessionsController = ReturnType<typeof useAgentSessions>;

interface SessionTerminalPaneProps {
  controller: AgentSessionsController;
  rootName: string | null;
  spaceNames: Map<string, string>;
}

export function SessionTerminalPane({
  controller,
  rootName,
  spaceNames,
}: SessionTerminalPaneProps) {
  const [metadataOpen, setMetadataOpen] = useState(false);
  const session = controller.selectedSession;
  const ptyId = controller.selectedPtyId;

  async function runAction(action: () => Promise<void>, errorMessage: string) {
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage, {
        description: getNativeErrorMessage(error),
      });
    }
  }

  function copyCommand() {
    const command =
      controller.selectedReentryResult?.command?.display ??
      (session ? commandDisplay(session) : null);
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

  if (!controller.selectedSessionId) {
    return <SelectSessionState />;
  }

  if (controller.selectedMissing) {
    return <SessionMissingState />;
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <PaneHeader
        session={session}
        ptyId={ptyId}
        rootName={rootName}
        spaceNames={spaceNames}
        metadataOpen={metadataOpen}
        onToggleMetadata={() => setMetadataOpen((open) => !open)}
        onCopyCommand={copyCommand}
        onCloseTerminal={() =>
          void runAction(
            controller.closeSelectedTerminal,
            m.sessions_toast_close_terminal_failed(),
          )
        }
        onOpenExternalTerminal={() =>
          void runAction(
            controller.openSelectedExternalTerminal,
            m.sessions_toast_external_terminal_failed(),
          )
        }
        onRevealFile={() =>
          void runAction(
            controller.revealSelectedSourceFile,
            m.sessions_toast_reveal_failed(),
          )
        }
      />
      {metadataOpen && session && (
        <SessionMetadata session={session} rootName={rootName} spaceNames={spaceNames} />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {ptyId ? (
          <ManagedTerminalSurface
            ptyId={ptyId}
            title={session?.title ?? m.sessions_title()}
          />
        ) : controller.reenteringSessionId ? (
          <TerminalPendingState />
        ) : controller.selectedReentryResult?.mode ===
            "external-active-unattachable" ||
          controller.selectedReentryResult?.mode === "error" ? (
          <ReentryErrorState
            result={controller.selectedReentryResult}
            onCopyCommand={copyCommand}
            onOpenExternalTerminal={() =>
              void runAction(
                controller.openSelectedExternalTerminal,
                m.sessions_toast_external_terminal_failed(),
              )
            }
          />
        ) : (
          <TerminalPendingState />
        )}
      </div>
    </section>
  );
}

interface PaneHeaderProps {
  session: AgentSession | null;
  ptyId: string | null;
  rootName: string | null;
  spaceNames: Map<string, string>;
  metadataOpen: boolean;
  onToggleMetadata: () => void;
  onCopyCommand: () => void;
  onCloseTerminal: () => void;
  onOpenExternalTerminal: () => void;
  onRevealFile: () => void;
}

function PaneHeader({
  session,
  ptyId,
  rootName,
  spaceNames,
  metadataOpen,
  onToggleMetadata,
  onCopyCommand,
  onCloseTerminal,
  onOpenExternalTerminal,
  onRevealFile,
}: PaneHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {session?.title ?? m.sessions_title()}
        </div>
        {session && (
          <div className="truncate text-xs text-muted-foreground">
            {statusLabel(session)} · {sourceLabel(session.source)} ·{" "}
            {scopeLabel(session, rootName, spaceNames)} ·{" "}
            {sessionTimeLabel(session)}
          </div>
        )}
      </div>
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
            <DropdownMenuItem onSelect={onToggleMetadata}>
              <Info />
              {metadataOpen
                ? m.sessions_action_hide_metadata()
                : m.sessions_action_view_metadata()}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!session?.sourceFile || !session.capabilities.canRevealFile}
              onSelect={onRevealFile}
            >
              <FileSearch />
              {m.sessions_action_reveal_file()}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function SessionMetadata({
  session,
  rootName,
  spaceNames,
}: {
  session: AgentSession;
  rootName: string | null;
  spaceNames: Map<string, string>;
}) {
  return (
    <dl className="grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b bg-muted/30 px-4 py-3 text-xs">
      <dt className="text-muted-foreground">{m.sessions_metadata_source()}</dt>
      <dd>{sourceLabel(session.source)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_scope()}</dt>
      <dd>{scopeLabel(session, rootName, spaceNames)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_status()}</dt>
      <dd>{statusLabel(session)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_last_activity()}</dt>
      <dd>{tooltipDateTime(session.lastActivityAt)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_cwd()}</dt>
      <dd className="truncate">{session.cwd ?? session.resumeCommand?.cwd ?? "—"}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_session_id()}</dt>
      <dd className="truncate">{session.sourceSessionId}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_source_file()}</dt>
      <dd className="truncate">{session.sourceFile?.path ?? "—"}</dd>
    </dl>
  );
}

function SelectSessionState() {
  return (
    <div className="min-w-0 flex-1">
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SquareTerminal />
          </EmptyMedia>
          <EmptyTitle>{m.sessions_select_title()}</EmptyTitle>
          <EmptyDescription>{m.sessions_select_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function SessionMissingState() {
  return (
    <div className="min-w-0 flex-1">
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyTitle>{m.sessions_missing_title()}</EmptyTitle>
          <EmptyDescription>{m.sessions_missing_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function TerminalPendingState() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquareTerminal />
        </EmptyMedia>
        <EmptyTitle>{m.sessions_resuming_title()}</EmptyTitle>
        <EmptyDescription>{m.sessions_resuming_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ReentryErrorState({
  result,
  onCopyCommand,
  onOpenExternalTerminal,
}: {
  result: NonNullable<AgentSessionsController["selectedReentryResult"]>;
  onCopyCommand: () => void;
  onOpenExternalTerminal: () => void;
}) {
  const command = result.command?.display;

  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyTitle>{m.sessions_reentry_error_title()}</EmptyTitle>
        <EmptyDescription>
          {result.error?.message ?? m.sessions_reentry_error_description()}
        </EmptyDescription>
      </EmptyHeader>
      {command && (
        <EmptyContent className="max-w-xl">
          <code className="w-full overflow-hidden rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
            {command}
          </code>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCopyCommand}>
              <Copy data-icon="inline-start" />
              {m.sessions_action_copy_resume_command()}
            </Button>
            <Button variant="ghost" size="sm" onClick={onOpenExternalTerminal}>
              <ExternalLink data-icon="inline-start" />
              {m.sessions_action_open_external_terminal()}
            </Button>
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}
