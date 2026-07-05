import { Copy, ExternalLink, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ManagedTerminalSurface } from "@/features/terminal/session-surface";
import type { useAgentSessions } from "../hooks";
import { scopeLabel, sourceLabel, tooltipDateTime } from "../lib";
import type { AgentSession, AgentSessionScopeGroup } from "../model";
import { statusLabel } from "./session-status";
import * as m from "@/paraglide/messages.js";

type AgentSessionsController = ReturnType<typeof useAgentSessions>;

interface SessionTerminalPaneProps {
  controller: AgentSessionsController;
  rootName: string | null;
  spaceNames: Map<string, string>;
  metadataOpen: boolean;
  onCopyCommand: () => void;
  onOpenExternalTerminal: () => void;
  rootScope: AgentSessionScopeGroup | null;
  onOpenScopeTerminal: (scope: AgentSessionScopeGroup) => Promise<void>;
}

export function SessionTerminalPane({
  controller,
  rootName,
  spaceNames,
  metadataOpen,
  onCopyCommand,
  onOpenExternalTerminal,
  rootScope,
  onOpenScopeTerminal,
}: SessionTerminalPaneProps) {
  const session = controller.selectedSession;
  const ptyId = controller.selectedPtyId;

  if (!controller.selectedSessionId) {
    if (
      !controller.loading &&
      !controller.error &&
      controller.result &&
      controller.result.status !== "error" &&
      controller.result.sessions.length === 0
    ) {
      return (
        <NoSessionsState
          rootScope={rootScope}
          onOpenScopeTerminal={onOpenScopeTerminal}
        />
      );
    }

    return (
      <SelectSessionState
        rootScope={rootScope}
        onOpenScopeTerminal={onOpenScopeTerminal}
      />
    );
  }

  if (controller.selectedMissing) {
    return <SessionMissingState />;
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      {metadataOpen && session && (
        <SessionMetadata
          session={session}
          rootName={rootName}
          spaceNames={spaceNames}
        />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {ptyId ? (
          <ManagedTerminalSurface
            ptyId={ptyId}
            title={session?.title ?? m.sessions_title()}
            containerClassName="pb-0"
          />
        ) : controller.reenteringSessionId ? (
          <TerminalPendingState />
        ) : controller.selectedReentryResult?.mode ===
            "external-active-unattachable" ||
          controller.selectedReentryResult?.mode === "error" ? (
          <ReentryErrorState
            result={controller.selectedReentryResult}
            onCopyCommand={onCopyCommand}
            onOpenExternalTerminal={onOpenExternalTerminal}
          />
        ) : (
          <TerminalPendingState />
        )}
      </div>
    </section>
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
      <dt className="text-muted-foreground">
        {m.sessions_metadata_last_activity()}
      </dt>
      <dd>{tooltipDateTime(session.lastActivityAt)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_cwd()}</dt>
      <dd className="truncate">
        {session.cwd ?? session.resumeCommand?.cwd ?? "—"}
      </dd>
      <dt className="text-muted-foreground">
        {m.sessions_metadata_session_id()}
      </dt>
      <dd className="truncate">{session.sourceSessionId}</dd>
      <dt className="text-muted-foreground">
        {m.sessions_metadata_source_file()}
      </dt>
      <dd className="truncate">{session.sourceFile?.path ?? "—"}</dd>
    </dl>
  );
}

function SelectSessionState({
  rootScope,
  onOpenScopeTerminal,
}: {
  rootScope: AgentSessionScopeGroup | null;
  onOpenScopeTerminal: (scope: AgentSessionScopeGroup) => Promise<void>;
}) {
  const terminalDisabled = !rootScope || rootScope.status !== "ready";

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
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            disabled={terminalDisabled}
            onClick={() =>
              rootScope ? void onOpenScopeTerminal(rootScope) : undefined
            }
          >
            <SquareTerminal data-icon="inline-start" />
            {m.sessions_action_open_terminal()}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function NoSessionsState({
  rootScope,
  onOpenScopeTerminal,
}: {
  rootScope: AgentSessionScopeGroup | null;
  onOpenScopeTerminal: (scope: AgentSessionScopeGroup) => Promise<void>;
}) {
  const terminalDisabled = !rootScope || rootScope.status !== "ready";

  return (
    <div className="min-w-0 flex-1">
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SquareTerminal />
          </EmptyMedia>
          <EmptyTitle>{m.sessions_empty_title()}</EmptyTitle>
          <EmptyDescription>{m.sessions_empty_description()}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            disabled={terminalDisabled}
            onClick={() =>
              rootScope ? void onOpenScopeTerminal(rootScope) : undefined
            }
          >
            <SquareTerminal data-icon="inline-start" />
            {m.sessions_action_open_terminal()}
          </Button>
        </EmptyContent>
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
          <EmptyDescription>
            {m.sessions_missing_description()}
          </EmptyDescription>
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
