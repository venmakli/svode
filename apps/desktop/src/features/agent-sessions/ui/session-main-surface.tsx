import { useEffect, useRef } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useAgentSessionSpace, useResolvedAgentSession } from "../hooks";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type { AgentSessionTarget, NewSessionDraftTarget } from "../model";
import { AGENT_SESSION_CONTENT_ATTRIBUTE } from "../lib/session-content";
import { NewSessionDraft } from "../chat/ui/new-session-draft";
import type { StartedSession } from "../chat/hooks/use-new-session-draft";
import { AgentSessionContent } from "./session-view";

/** A session as the one object of the main area. */
export function AgentSessionMainSurface({
  target,
  focus,
  focusTerminal = false,
  onOpenRoutine,
  onOpenAgentSettings,
}: {
  target: AgentSessionTarget;
  /** Move focus into the main area, as after "Expand"; the sidebar keeps it. */
  focus: boolean;
  /** The session was started for work in its terminal, e.g. a new session. */
  focusTerminal?: boolean;
  onOpenRoutine(routine: RoutineLaunchLink): void;
  onOpenAgentSettings?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  // The terminal takes focus itself once it is attached.
  const focusRef = useRef(focus && !focusTerminal);
  useEffect(() => {
    if (focusRef.current) surfaceRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={surfaceRef} tabIndex={-1} className="h-full outline-none">
      <AgentSessionContent
        key={`${target.sessionId}\n${target.launchId ?? ""}`}
        target={target}
        focusTerminal={focusTerminal}
        onOpenRoutine={onOpenRoutine}
        onOpenAgentSettings={onOpenAgentSettings}
      />
    </div>
  );
}

/** A new session draft as the one object of the main area; focus goes to its composer. */
export function AgentSessionDraftMainSurface({
  draft,
  onStarted,
  onOpenTerminal,
  onOpenAgentSettings,
}: {
  draft: NewSessionDraftTarget;
  onStarted: (started: StartedSession) => void;
  onOpenTerminal: (spacePath: string) => void;
  onOpenAgentSettings: () => void;
}) {
  return (
    <div
      {...{ [AGENT_SESSION_CONTENT_ATTRIBUTE]: "" }}
      className="flex h-full min-h-0 flex-col pt-3"
    >
      <NewSessionDraft
        key={draft.draftId}
        spacePath={draft.spacePath}
        onStarted={onStarted}
        onOpenTerminal={onOpenTerminal}
        onOpenAgentSettings={onOpenAgentSettings}
      />
    </div>
  );
}

/** Window header breadcrumbs of a session in the main area: Space → session. */
export function AgentSessionBreadcrumbs({
  target,
}: {
  target: AgentSessionTarget;
}) {
  const session = useResolvedAgentSession(target);
  const space = useAgentSessionSpace(session);
  if (!session) return null;

  return (
    <div className="min-w-0 flex-1 px-2">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm">
          {space && (
            <>
              <BreadcrumbItem className="min-w-0">
                <span className="block max-w-[220px] truncate">
                  {space.name}
                </span>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="shrink-0" />
            </>
          )}
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="block max-w-[320px] truncate">
              {session.title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
