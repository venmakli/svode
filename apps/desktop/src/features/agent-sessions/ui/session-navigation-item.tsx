import type { ReactNode } from "react";
import { BotMessageSquare } from "lucide-react";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  NavigationSidebarItem,
  type NavigationKey,
} from "@/features/navigation";
import { useAgentSessionCatalog, useAgentSessionSpace } from "../hooks";
import {
  agentSessionForNavigationKey,
  type AgentSession,
  type AgentSessionTarget,
} from "../model";
import {
  SessionStatusMarker,
  statusMarkerLabel,
  statusTooltipDetail,
} from "./session-status";

interface AgentSessionNavigationItemProps {
  navigationKey: NavigationKey;
  /** Last known title, shown while the catalog does not list the session. */
  fallbackTitle: string;
  /** The session shown as the main area object. */
  mainTarget: AgentSessionTarget | null;
  onOpen: (session: AgentSession) => void;
  menu: ReactNode;
  onClose?: () => void;
  temporary?: boolean;
  onKeep?: () => void;
  /** A pinned session in a list that mixes it with others. */
  pinned?: boolean;
  /**
   * A session of another project than the open one: it is resolved against
   * that project's list and its Space named by `spaceName`.
   */
  project?: {
    sessions: readonly AgentSession[];
    spaceName: (session: AgentSession) => string | null;
  };
}

/**
 * A session row of a sidebar navigation section: the session sign with its
 * status marker, and its agent and Space in the tooltip. A session the
 * catalog does not list is unavailable.
 */
export function AgentSessionNavigationItem({
  navigationKey,
  fallbackTitle,
  mainTarget,
  onOpen,
  menu,
  onClose,
  temporary,
  onKeep,
  pinned,
  project,
}: AgentSessionNavigationItemProps) {
  const catalogSession = useAgentSessionCatalog((state) =>
    project
      ? null
      : agentSessionForNavigationKey(navigationKey, state.sessions),
  );
  const session = project
    ? agentSessionForNavigationKey(navigationKey, project.sessions)
    : catalogSession;
  const catalogSpace = useAgentSessionSpace(project ? null : session);
  const spaceName =
    project && session ? project.spaceName(session) : catalogSpace?.name;
  const agents = useAgentAdapterDictionary();
  const active = Boolean(
    session &&
    mainTarget &&
    (mainTarget.sessionId === session.id ||
      (mainTarget.launchId !== null &&
        mainTarget.launchId === session.launchId)),
  );

  return (
    <NavigationSidebarItem
      title={session?.title ?? fallbackTitle}
      icon={<BotMessageSquare className="size-4" />}
      status={
        session
          ? {
              marker: <SessionStatusMarker session={session} />,
              label: statusMarkerLabel(session),
            }
          : undefined
      }
      tooltip={
        session && (
          <>
            <span>{statusTooltipDetail(session)}</span>
            <span>
              {agents.label(session.source)}
              {spaceName ? ` · ${spaceName}` : ""}
            </span>
          </>
        )
      }
      active={active}
      unavailable={!session}
      onOpen={() => {
        if (session) onOpen(session);
      }}
      menu={menu}
      onClose={onClose}
      temporary={temporary}
      onKeep={onKeep}
      pinned={pinned}
    />
  );
}
