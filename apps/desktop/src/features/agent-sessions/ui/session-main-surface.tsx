import { useEffect, useRef, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { BreadcrumbPage } from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import type { OpenWithGroup } from "@/features/external-open";
import { useSpace } from "@/features/space";
import { useAgentSessionSpace } from "../hooks";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type {
  AgentSessionTarget,
  DraftSpaceChoices,
  NewSessionDraftTarget,
} from "../model";
import { AGENT_SESSION_CONTENT_ATTRIBUTE } from "../lib/session-content";
import { NewSessionDraft } from "../chat/ui/new-session-draft";
import type { StartedSession } from "../chat/hooks/use-new-session-draft";
import { AgentSessionContent, type AgentSessionChrome } from "./session-view";
import * as m from "@/paraglide/messages.js";

/** What a session gives the main area top bar. */
export interface AgentSessionMainHeader {
  /** The Space of the session, which the breadcrumbs start with. */
  spacePath: string;
  /** The last breadcrumb: agent icon, title and "status · time". */
  current: ReactNode;
  /** The ⋯ menu of the session, right after the breadcrumbs; null without actions. */
  menu: ReactNode;
  /** The continuation group of "Open with", ahead of the project applications. */
  openWith: OpenWithGroup | null;
}

/** A session as the one object of the main area. */
export function AgentSessionMainSurface({
  target,
  focus,
  focusTerminal = false,
  onOpenRoutine,
  onOpenAgentSettings,
  renderHeader,
}: {
  target: AgentSessionTarget;
  /** Move focus into the main area, as after "Expand"; the sidebar keeps it. */
  focus: boolean;
  /** The session was started for work in its terminal, e.g. a new session. */
  focusTerminal?: boolean;
  onOpenRoutine(routine: RoutineLaunchLink): void;
  onOpenAgentSettings?: () => void;
  /** Publishes the session's part of the main area top bar. */
  renderHeader: (header: AgentSessionMainHeader) => ReactNode;
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
        renderChrome={(chrome) => (
          <MainSessionHeader chrome={chrome} renderHeader={renderHeader} />
        )}
      />
    </div>
  );
}

function MainSessionHeader({
  chrome: { view, identity, status, menu, openWith },
  renderHeader,
}: {
  chrome: AgentSessionChrome;
  renderHeader: (header: AgentSessionMainHeader) => ReactNode;
}) {
  const space = useAgentSessionSpace(view.session);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  return renderHeader({
    spacePath: space?.spacePath ?? activeRootPath ?? "",
    current: identity ? (
      <>
        <BreadcrumbPage className="flex min-w-0 max-w-[320px] items-center gap-1.5">
          <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
            {identity.icon}
          </span>
          <span className="truncate">{identity.title}</span>
        </BreadcrumbPage>
        {status}
      </>
    ) : (
      <Skeleton className="h-4 w-40" />
    ),
    menu,
    openWith,
  });
}

/** What a new session draft gives the main area top bar. */
export interface AgentSessionDraftMainHeader {
  /** The Space chosen in the draft, which the breadcrumbs start with. */
  spacePath: string;
  /** The last breadcrumb: "New session". */
  current: ReactNode;
}

/** A new session draft as the one object of the main area; focus goes to its composer. */
export function AgentSessionDraftMainSurface({
  draft,
  onStarted,
  onOpenAgentSettings,
  spaceChoices,
  renderHeader,
}: {
  draft: NewSessionDraftTarget;
  /** Places to list instead of the Spaces of the active project. */
  spaceChoices?: DraftSpaceChoices;
  onStarted: (started: StartedSession) => void;
  onOpenAgentSettings: () => void;
  /** Publishes the draft's part of the main area top bar. */
  renderHeader: (header: AgentSessionDraftMainHeader) => ReactNode;
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
        onOpenAgentSettings={onOpenAgentSettings}
        spaceChoices={spaceChoices}
        renderHeader={({ spacePath }) =>
          renderHeader({
            spacePath,
            current: (
              <BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
                <Plus
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate">{m.sessions_new_title()}</span>
              </BreadcrumbPage>
            ),
          })
        }
      />
    </div>
  );
}
