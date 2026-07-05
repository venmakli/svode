import type { ReactNode } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { getNativeErrorMessage } from "@/platform/native/errors";
import type { useAgentSessions } from "../hooks";
import { openSessionCwdInExternalTerminal } from "../api";
import { scopeLabel } from "../lib";
import type { AgentSession, AgentSessionGroup } from "../model";
import { SessionRow } from "./session-row";
import * as m from "@/paraglide/messages.js";

const scopeRowActionVisibility =
  "opacity-0 transition-[opacity,transform] disabled:opacity-0 focus-visible:opacity-100 aria-expanded:opacity-100 data-[state=open]:opacity-100 group-hover/session-scope-row:opacity-100 group-has-[[data-sidebar=menu-action]:focus-visible]/session-scope-row:opacity-100 group-hover/session-scope-row:disabled:opacity-50 group-has-[[data-sidebar=menu-action]:focus-visible]/session-scope-row:disabled:opacity-50";

const scopeRowBadgeVisibility =
  "group-hover/session-scope-row:opacity-0 group-has-[[data-sidebar=menu-action]:focus-visible]/session-scope-row:opacity-0";

type AgentSessionsController = ReturnType<typeof useAgentSessions>;

interface SessionsListProps {
  controller: AgentSessionsController;
  rootIcon: string | null;
  rootName: string | null;
  spaceIcons: Map<string, string>;
  spaceNames: Map<string, string>;
  onOpenAppSettings?: () => void;
}

export function SessionsList({
  controller,
  rootIcon,
  rootName,
  spaceIcons,
  spaceNames,
  onOpenAppSettings,
}: SessionsListProps) {
  const sourceUnavailable =
    controller.error ??
    (controller.result?.status === "error" ? "source" : null);

  async function runAction(action: () => Promise<void>, errorMessage: string) {
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage, {
        description: getNativeErrorMessage(error),
      });
    }
  }

  function copyCommand(session: AgentSession) {
    const command = session.resumeCommand?.display;
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

  function openExternalTerminal(session: AgentSession) {
    const cwd = session.resumeCommand?.cwd ?? session.cwd;
    if (!cwd) return;
    void runAction(
      () => openSessionCwdInExternalTerminal(cwd),
      m.sessions_toast_external_terminal_failed(),
    );
  }

  const collapsibleSpaceGroups = controller.groups.spaces.filter(
    (group) => group.total > 0,
  );
  const shouldCollapseSpaces = collapsibleSpaceGroups.some(
    (group) => !controller.collapsedGroupIds.has(group.id),
  );
  const spacesExpansionLabel = shouldCollapseSpaces
    ? m.sidebar_collapse_all()
    : m.sidebar_expand_all();
  const nowHasOpenTerminals = Boolean(
    controller.groups.now?.sessions.some((session) => session.runtime?.ptyId),
  );

  return (
    <Sidebar
      variant="floating"
      collapsible="none"
      className="mt-0 mr-2 ml-0 h-full w-80 shrink-0 rounded-lg border border-sidebar-border shadow-sm"
    >
      <SidebarHeader>
        <div className="flex h-8 shrink-0 items-center gap-2 px-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <SidebarInput
              value={controller.searchQuery}
              placeholder={m.sessions_search_placeholder()}
              className="h-7 pl-7 text-sm"
              onChange={(event) =>
                controller.setSearchQuery(event.target.value)
              }
            />
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.sessions_action_refresh()}
            disabled={controller.refreshing || controller.loading}
            onClick={() =>
              void runAction(
                controller.refresh,
                m.sessions_toast_refresh_failed(),
              )
            }
          >
            <RefreshCw
              className={cn(controller.refreshing && "animate-spin")}
            />
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {controller.loading ? (
          <SessionsListSkeleton />
        ) : sourceUnavailable ? (
          <SourceUnavailableState
            onRetry={() =>
              void runAction(
                controller.refresh,
                m.sessions_toast_refresh_failed(),
              )
            }
            onOpenAppSettings={onOpenAppSettings}
          />
        ) : controller.groups.visibleSessionIds.size === 0 &&
          controller.groups.spaces.length === 0 ? (
          <NoResultsState />
        ) : (
          <>
            {controller.groups.pinned && (
              <SessionGroupSection
                group={controller.groups.pinned}
                label={m.sessions_group_pinned()}
                controller={controller}
                rootName={rootName}
                spaceNames={spaceNames}
                runAction={runAction}
                copyCommand={copyCommand}
                openExternalTerminal={openExternalTerminal}
              />
            )}
            {controller.groups.now && (
              <SessionGroupSection
                group={controller.groups.now}
                label={m.sessions_group_now()}
                headerAction={
                  <CloseAllTerminalsAction
                    disabled={!nowHasOpenTerminals}
                    onCloseAll={() =>
                      void runAction(
                        controller.closeAllTerminals,
                        m.sessions_toast_close_terminal_failed(),
                      )
                    }
                  />
                }
                controller={controller}
                rootName={rootName}
                spaceNames={spaceNames}
                runAction={runAction}
                copyCommand={copyCommand}
                openExternalTerminal={openExternalTerminal}
              />
            )}
            {controller.groups.spaces.length > 0 && (
              <SidebarGroup className="pt-2">
                <SidebarGroupLabel className="group/sessions-past-header pr-8">
                  <span className="truncate">{m.sessions_group_spaces()}</span>
                  <SpaceGroupsExpansionAction
                    disabled={collapsibleSpaceGroups.length === 0}
                    label={spacesExpansionLabel}
                    action={shouldCollapseSpaces ? "collapse" : "expand"}
                    onToggle={() =>
                      controller.setGroupsCollapsed(
                        collapsibleSpaceGroups.map((group) => group.id),
                        shouldCollapseSpaces,
                      )
                    }
                  />
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {controller.groups.spaces.map((group) => (
                      <SessionSpaceGroupItem
                        key={group.id}
                        group={group}
                        label={groupLabel(group, rootName, spaceNames)}
                        icon={groupIcon(group, rootIcon, spaceIcons)}
                        collapsed={controller.collapsedGroupIds.has(group.id)}
                        controller={controller}
                        rootName={rootName}
                        spaceNames={spaceNames}
                        runAction={runAction}
                        copyCommand={copyCommand}
                        openExternalTerminal={openExternalTerminal}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </>
        )}
      </SidebarContent>
    </Sidebar>
  );
}

interface SessionGroupSectionProps {
  group: AgentSessionGroup;
  label: string;
  headerAction?: ReactNode;
  controller: AgentSessionsController;
  rootName: string | null;
  spaceNames: Map<string, string>;
  runAction: (
    action: () => Promise<void>,
    errorMessage: string,
  ) => Promise<void>;
  copyCommand: (session: AgentSession) => void;
  openExternalTerminal: (session: AgentSession) => void;
}

function SessionGroupSection({
  group,
  label,
  headerAction,
  controller,
  rootName,
  spaceNames,
  runAction,
  copyCommand,
  openExternalTerminal,
}: SessionGroupSectionProps) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        className={cn(headerAction && "group/sessions-group-header pr-8")}
      >
        <span className="truncate">{label}</span>
        {headerAction}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SessionGroupMenu
          group={group}
          controller={controller}
          rootName={rootName}
          spaceNames={spaceNames}
          runAction={runAction}
          copyCommand={copyCommand}
          openExternalTerminal={openExternalTerminal}
        />
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface SessionSpaceGroupItemProps {
  group: AgentSessionGroup;
  label: string;
  icon?: string;
  collapsed: boolean;
  controller: AgentSessionsController;
  rootName: string | null;
  spaceNames: Map<string, string>;
  runAction: (
    action: () => Promise<void>,
    errorMessage: string,
  ) => Promise<void>;
  copyCommand: (session: AgentSession) => void;
  openExternalTerminal: (session: AgentSession) => void;
}

function SessionSpaceGroupItem({
  group,
  label,
  icon,
  collapsed,
  controller,
  rootName,
  spaceNames,
  runAction,
  copyCommand,
  openExternalTerminal,
}: SessionSpaceGroupItemProps) {
  const hasSessions = group.total > 0;
  const scope = group.scope;
  const terminalDisabled = !scope || scope.status !== "ready";
  const menu = (
    <SessionGroupMenu
      group={group}
      controller={controller}
      rootName={rootName}
      spaceNames={spaceNames}
      runAction={runAction}
      copyCommand={copyCommand}
      openExternalTerminal={openExternalTerminal}
    />
  );
  const row = (
    <SidebarMenuItem>
      <div className="group/session-scope-row relative">
        <SidebarMenuButton
          type="button"
          aria-expanded={hasSessions ? !collapsed : undefined}
          className="pr-20 group-has-data-[sidebar=menu-action]/menu-item:pr-20"
          onClick={
            hasSessions
              ? () => controller.toggleGroupCollapsed(group.id)
              : undefined
          }
        >
          <span className="shrink-0" aria-hidden>
            {icon || "\u{1F4C1}"}
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </SidebarMenuButton>
        {hasSessions && (
          <CollapsibleTrigger asChild>
            <SidebarMenuAction
              className={cn(
                "left-2 bg-sidebar-accent text-sidebar-accent-foreground data-[state=open]:rotate-90",
                scopeRowActionVisibility,
              )}
            >
              <ChevronRight />
            </SidebarMenuAction>
          </CollapsibleTrigger>
        )}
        <SidebarMenuBadge
          className={cn(
            "right-1 font-normal text-sidebar-foreground/70 transition-opacity",
            scopeRowBadgeVisibility,
          )}
        >
          {m.sessions_group_count({ count: group.total })}
        </SidebarMenuBadge>
        {scope && (
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuAction
                type="button"
                disabled={terminalDisabled}
                className={cn(
                  "right-1 disabled:pointer-events-none",
                  scopeRowActionVisibility,
                )}
                aria-label={m.sessions_action_open_terminal()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void runAction(
                    () => controller.openNewSessionTerminal(scope),
                    m.sessions_toast_open_terminal_failed(),
                  );
                }}
              >
                <SquareTerminal />
              </SidebarMenuAction>
            </TooltipTrigger>
            <TooltipContent side="top">
              {m.sessions_action_open_terminal()}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {hasSessions && <CollapsibleContent>{menu}</CollapsibleContent>}
    </SidebarMenuItem>
  );

  if (!hasSessions) return row;

  return (
    <Collapsible
      asChild
      open={!collapsed}
      onOpenChange={(open) => {
        if (open === collapsed) controller.toggleGroupCollapsed(group.id);
      }}
    >
      {row}
    </Collapsible>
  );
}

interface SessionGroupMenuProps {
  group: AgentSessionGroup;
  controller: AgentSessionsController;
  rootName: string | null;
  spaceNames: Map<string, string>;
  runAction: (
    action: () => Promise<void>,
    errorMessage: string,
  ) => Promise<void>;
  copyCommand: (session: AgentSession) => void;
  openExternalTerminal: (session: AgentSession) => void;
}

function SessionGroupMenu({
  group,
  controller,
  rootName,
  spaceNames,
  runAction,
  copyCommand,
  openExternalTerminal,
}: SessionGroupMenuProps) {
  return (
    <SidebarMenu>
      {group.sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          groupId={group.id}
          source={group.kind === "space" ? "space" : group.kind}
          selected={controller.selectedSessionId === session.id}
          reentering={controller.reenteringSessionId === session.id}
          pinning={controller.pinningSessionIds.has(session.id)}
          rootName={rootName}
          spaceNames={spaceNames}
          onSelect={(item, source, groupId) =>
            void controller.selectSession(item, source, groupId)
          }
          onTogglePinned={(item) =>
            void runAction(
              () => controller.togglePinned(item),
              m.sessions_toast_pin_failed(),
            )
          }
          onCloseTerminal={() =>
            void runAction(() => {
              const ptyId = session.runtime?.ptyId;
              return ptyId
                ? controller.closeTerminal(session.id, ptyId)
                : Promise.resolve();
            }, m.sessions_toast_close_terminal_failed())
          }
          onCopyCommand={copyCommand}
          onOpenExternalTerminal={openExternalTerminal}
        />
      ))}
      {group.hasMore && (
        <SidebarMenuItem>
          <SidebarMenuButton
            className="text-sidebar-foreground/70"
            onClick={() => controller.showMore(group.id)}
          >
            <MoreHorizontal />
            <span>{m.sessions_more()}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  );
}

function CloseAllTerminalsAction({
  disabled,
  onCloseAll,
}: {
  disabled: boolean;
  onCloseAll: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarGroupAction
          aria-label={m.sessions_action_close_all_terminals()}
          disabled={disabled}
          className="size-5 text-sidebar-foreground/70 opacity-0 transition-opacity hover:bg-transparent hover:text-sidebar-foreground/70 disabled:pointer-events-none disabled:opacity-40 group-hover/sessions-group-header:opacity-100 group-focus-within/sessions-group-header:opacity-100 focus-visible:opacity-100 [&>svg]:size-3"
          onClick={onCloseAll}
        >
          <X />
        </SidebarGroupAction>
      </TooltipTrigger>
      <TooltipContent side="right">
        {m.sessions_action_close_all_terminals()}
      </TooltipContent>
    </Tooltip>
  );
}

function SpaceGroupsExpansionAction({
  disabled,
  label,
  action,
  onToggle,
}: {
  disabled: boolean;
  label: string;
  action: "collapse" | "expand";
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarGroupAction
          aria-label={label}
          disabled={disabled}
          className="size-5 text-sidebar-foreground/70 opacity-0 transition-opacity hover:bg-transparent hover:text-sidebar-foreground/70 disabled:pointer-events-none disabled:opacity-40 group-hover/sessions-past-header:opacity-100 group-focus-within/sessions-past-header:opacity-100 focus-visible:opacity-100 [&>svg]:size-3"
          onClick={onToggle}
        >
          {action === "collapse" ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </SidebarGroupAction>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function groupLabel(
  group: AgentSessionGroup,
  rootName: string | null,
  spaceNames: Map<string, string>,
): string {
  if (group.scope) return group.scope.name;

  const first = group.sessions[0];
  return first
    ? scopeLabel(first, rootName, spaceNames)
    : m.sessions_group_space();
}

function groupIcon(
  group: AgentSessionGroup,
  rootIcon: string | null,
  spaceIcons: Map<string, string>,
): string {
  if (group.scope) return group.scope.icon || "\u{1F4C1}";

  const first = group.sessions[0];
  if (!first) return "\u{1F4C1}";
  if (first.scopeKind === "project") return rootIcon || "\u{1F4C1}";
  return (
    (first.spaceId ? spaceIcons.get(first.spaceId) : undefined) ??
    (first.spacePath ? spaceIcons.get(first.spacePath) : undefined) ??
    "\u{1F4C1}"
  );
}

function SessionsListSkeleton() {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {Array.from({ length: 8 }, (_, index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SourceUnavailableState({
  onRetry,
  onOpenAppSettings,
}: {
  onRetry: () => void;
  onOpenAppSettings?: () => void;
}) {
  return (
    <Empty className="min-h-72 border-0 p-3">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RefreshCw />
        </EmptyMedia>
        <EmptyTitle>{m.sessions_source_unavailable_title()}</EmptyTitle>
        <EmptyDescription>
          {m.sessions_source_unavailable_description()}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button variant="outline" size="sm" onClick={onRetry}>
          {m.sessions_action_retry()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!onOpenAppSettings}
          onClick={onOpenAppSettings}
        >
          {m.sessions_action_open_settings()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function NoResultsState() {
  return (
    <Empty className="min-h-72 border-0 p-3">
      <EmptyHeader>
        <EmptyTitle>{m.sessions_no_results_title()}</EmptyTitle>
        <EmptyDescription>
          {m.sessions_no_results_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
