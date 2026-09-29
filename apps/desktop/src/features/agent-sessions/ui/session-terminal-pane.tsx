import { SquareTerminal } from "lucide-react";
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
import type { AgentSessionScopeGroup } from "../model";
import {
  ReentryErrorState,
  SessionMetadata,
  SessionMissingState,
  SessionResumingState,
} from "./session-states";
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
          <SessionResumingState />
        ) : controller.selectedReentryResult?.mode === "error" ? (
          <ReentryErrorState
            result={controller.selectedReentryResult}
            onCopyCommand={onCopyCommand}
            onOpenExternalTerminal={onOpenExternalTerminal}
          />
        ) : (
          <SessionResumingState />
        )}
      </div>
    </section>
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
