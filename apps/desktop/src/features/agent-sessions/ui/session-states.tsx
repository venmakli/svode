import { Copy, RotateCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { AgentSessionReentryResult } from "../api";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import { scopeLabel, tooltipDateTime } from "../lib";
import type { AgentSession } from "../model";
import { ExternalTerminalIcon } from "./external-terminal-icon";
import { statusSourceLabel, statusText } from "./session-status";
import * as m from "@/paraglide/messages.js";

export function SessionMetadata({
  session,
  rootName,
  spaceNames,
}: {
  session: AgentSession;
  rootName: string | null;
  spaceNames: Map<string, string>;
}) {
  const agents = useAgentAdapterDictionary();
  return (
    <dl className="grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b bg-muted/30 px-4 py-3 text-xs">
      <dt className="text-muted-foreground">{m.sessions_metadata_source()}</dt>
      <dd>{agents.label(session.source)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_scope()}</dt>
      <dd>{scopeLabel(session, rootName, spaceNames)}</dd>
      <dt className="text-muted-foreground">{m.sessions_metadata_status()}</dt>
      <dd>{statusText(session)}</dd>
      <dt className="text-muted-foreground">
        {m.sessions_metadata_status_source()}
      </dt>
      <dd>{statusSourceLabel(session)}</dd>
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
    </dl>
  );
}

export function SessionMissingState() {
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

export function SessionResumingState() {
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

export function ReentryErrorState({
  result,
  onCopyCommand,
  onOpenExternalTerminal,
  onRetry,
}: {
  result: AgentSessionReentryResult;
  onCopyCommand: () => void;
  onOpenExternalTerminal: () => void;
  onRetry?: () => void;
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
      {(command || onRetry) && (
        <EmptyContent className="max-w-xl">
          {command && (
            <code className="w-full overflow-hidden rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
              {command}
            </code>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCw data-icon="inline-start" />
                {m.sessions_action_retry()}
              </Button>
            )}
            {command && (
              <>
                <Button variant="outline" size="sm" onClick={onCopyCommand}>
                  <Copy data-icon="inline-start" />
                  {m.sessions_action_copy_resume_command()}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenExternalTerminal}
                >
                  <ExternalTerminalIcon data-icon="inline-start" />
                  {m.sessions_action_open_external_terminal()}
                </Button>
              </>
            )}
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}
