import { useState } from "react";
import {
  Copy,
  ExternalLink,
  MoreHorizontal,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/shared/lib/utils";
import {
  scopeLabel,
  sessionTimeLabel,
  sourceLabel,
  tooltipDateTime,
} from "../lib";
import {
  isPendingSessionId,
  type AgentSession,
  type AgentSessionSelectionSource,
} from "../model";
import { SessionStatusMarker, statusLabel } from "./session-status";
import * as m from "@/paraglide/messages.js";

interface SessionRowProps {
  session: AgentSession;
  groupId: string;
  source: AgentSessionSelectionSource;
  selected: boolean;
  reentering: boolean;
  pinning: boolean;
  rootName: string | null;
  spaceNames: Map<string, string>;
  onSelect: (
    session: AgentSession,
    source: AgentSessionSelectionSource,
    groupId: string,
  ) => void;
  onTogglePinned: (session: AgentSession) => void;
  onCloseTerminal: () => void;
  onCopyCommand: (session: AgentSession) => void;
  onOpenExternalTerminal: (session: AgentSession) => void;
}

export function SessionRow({
  session,
  groupId,
  source,
  selected,
  reentering,
  pinning,
  rootName,
  spaceNames,
  onSelect,
  onTogglePinned,
  onCloseTerminal,
  onCopyCommand,
  onOpenExternalTerminal,
}: SessionRowProps) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const time = sessionTimeLabel(session);
  const hasOpenTerminal = session.runtime?.live === true;
  const canPin =
    session.source !== "unknown" && !isPendingSessionId(session.id);

  return (
    <SidebarMenuItem data-actions-open={actionsOpen}>
      {reentering && (
        <span className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            type="button"
            isActive={selected}
            className={cn(
              "pr-16 group-has-data-[sidebar=menu-action]/menu-item:pr-16",
              reentering && "pl-3",
            )}
            onClick={() => onSelect(session, source, groupId)}
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {session.title}
            </span>
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="flex max-w-80 flex-col items-start gap-1 text-left"
        >
          <span className="font-medium">{session.title}</span>
          <span>
            {sourceLabel(session.source)} ·{" "}
            {scopeLabel(session, rootName, spaceNames)}
          </span>
          <span>
            {m.sessions_tooltip_status()}: {statusLabel(session)}
          </span>
          {hasOpenTerminal && <span>{m.sessions_tooltip_terminal_open()}</span>}
          {session.waitingSince && (
            <span>
              {m.sessions_tooltip_waiting_since()}:{" "}
              {tooltipDateTime(session.waitingSince)}
            </span>
          )}
          <span>
            {m.sessions_tooltip_last_activity()}:{" "}
            {tooltipDateTime(session.lastActivityAt)}
          </span>
          <span>
            {m.sessions_tooltip_session_id()}: {session.sourceSessionId}
          </span>
        </TooltipContent>
      </Tooltip>
      <SidebarMenuBadge className="gap-1.5 font-normal text-sidebar-foreground/70 transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0 group-data-[actions-open=true]/menu-item:opacity-0 [&_svg]:size-3 [&_svg]:shrink-0">
        <SessionStatusMarker session={session} />
        <span>{time}</span>
      </SidebarMenuBadge>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuAction
            type="button"
            showOnHover
            disabled={pinning || !canPin}
            className="right-7 disabled:pointer-events-none disabled:opacity-50 group-data-[actions-open=true]/menu-item:opacity-100"
            aria-label={
              session.pinned
                ? m.sessions_action_unpin()
                : m.sessions_action_pin()
            }
            onClick={() => onTogglePinned(session)}
          >
            {session.pinned ? <PinOff /> : <Pin />}
          </SidebarMenuAction>
        </TooltipTrigger>
        <TooltipContent side="top">
          {session.pinned ? m.sessions_action_unpin() : m.sessions_action_pin()}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            type="button"
            showOnHover
            className="group-data-[actions-open=true]/menu-item:opacity-100"
            aria-label={m.sessions_action_more()}
          >
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" className="min-w-48">
          <DropdownMenuGroup>
            {hasOpenTerminal && (
              <DropdownMenuItem onSelect={onCloseTerminal}>
                <X />
                {m.sessions_action_close_terminal()}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={!session.resumeCommand}
              onSelect={() => onCopyCommand(session)}
            >
              <Copy />
              {m.sessions_action_copy_resume_command()}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!session.resumeCommand?.cwd && !session.cwd}
              onSelect={() => onOpenExternalTerminal(session)}
            >
              <ExternalLink />
              {m.sessions_action_open_external_terminal()}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
