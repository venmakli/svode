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
import { SessionStatusMarker } from "./session-status";

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
}: AgentSessionNavigationItemProps) {
  const session = useAgentSessionCatalog((state) =>
    agentSessionForNavigationKey(navigationKey, state.sessions),
  );
  const space = useAgentSessionSpace(session);
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
      icon={
        <span className="relative flex">
          <BotMessageSquare className="size-4" />
          {session && (
            <span className="absolute -right-1 -bottom-1 flex rounded-full bg-sidebar">
              <SessionStatusMarker session={session} className="size-2.5" />
            </span>
          )}
        </span>
      }
      tooltip={
        session && (
          <span>
            {agents.label(session.source)}
            {space ? ` · ${space.name}` : ""}
          </span>
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
    />
  );
}
