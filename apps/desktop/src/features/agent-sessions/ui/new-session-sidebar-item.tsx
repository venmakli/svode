import { useState, type ReactNode } from "react";
import { Box, Check, ChevronDown, FolderClosed, Plus } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useAgentSessionScopes } from "../hooks";
import {
  newSessionScopeChoices,
  resolveNewSessionTarget,
  type AgentSessionScopeGroup,
  type NewSessionSpaceRef,
  type NewSessionTarget,
} from "../model";
import * as m from "@/paraglide/messages.js";

interface NewSessionSidebarItemProps {
  /** Space of the main area object; null while it is not known. */
  space: NewSessionSpaceRef | null;
  onStart: (scope: AgentSessionScopeGroup) => void;
  /** Another action of the row, e.g. the terminal panel toggle. */
  action?: ReactNode;
}

/**
 * "New session" of the main sidebar: the row starts a session in the Space
 * of the main area object, and its chooser in any available Space.
 */
export function NewSessionSidebarItem({
  space,
  onStart,
  action,
}: NewSessionSidebarItemProps) {
  const scopes = useAgentSessionScopes();
  const target = resolveNewSessionTarget(scopes, space);
  const current = target.status === "ready" ? target.scope : null;
  const label = current
    ? m.sessions_new_in_space({ space: current.name })
    : m.sessions_action_new();

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            type="button"
            className={cn("pr-14", !current && "text-sidebar-foreground/50")}
            aria-label={label}
            aria-disabled={!current || undefined}
            onClick={current ? () => onStart(current) : undefined}
          >
            <Plus />
            <span>{m.sessions_action_new()}</span>
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">
          {current ? label : unavailableReason(target)}
        </TooltipContent>
      </Tooltip>
      <SpaceChooser
        choices={newSessionScopeChoices(scopes, current)}
        current={current}
        onChoose={onStart}
      />
      {action}
    </SidebarMenuItem>
  );
}

function unavailableReason(target: NewSessionTarget): string {
  switch (target.status) {
    case "missing":
      return m.sessions_new_space_missing({ space: target.name });
    case "broken":
      return m.sessions_new_space_broken({ space: target.name });
    default:
      return m.sessions_new_space_unknown();
  }
}

function SpaceChooser({
  choices,
  current,
  onChoose,
}: {
  choices: AgentSessionScopeGroup[];
  current: AgentSessionScopeGroup | null;
  onChoose: (scope: AgentSessionScopeGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <SidebarMenuAction
              type="button"
              showOnHover
              className="right-7"
              aria-label={m.sessions_new_choose_space()}
            >
              <ChevronDown />
            </SidebarMenuAction>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">
          {m.sessions_new_choose_space()}
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="w-64 p-0" side="right" align="start">
        <Command filter={matchSpaceName}>
          <CommandInput placeholder={m.sessions_new_space_search()} />
          <CommandList>
            <CommandEmpty>{m.sessions_new_space_empty()}</CommandEmpty>
            <CommandGroup>
              {choices.map((scope) => {
                const isCurrent = scope.scopeId === current?.scopeId;
                return (
                  <CommandItem
                    key={scope.id}
                    value={scope.id}
                    keywords={[scope.name]}
                    disabled={scope.status !== "ready"}
                    onSelect={() => {
                      setOpen(false);
                      onChoose(scope);
                    }}
                  >
                    <ScopeIcon scope={scope} />
                    <span className="min-w-0 flex-1 truncate">
                      {scope.name}
                    </span>
                    {isCurrent && (
                      <>
                        <Check aria-hidden />
                        <span className="sr-only">
                          {m.sessions_new_space_current()}
                        </span>
                      </>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Spaces are found by name only, not by their ids. */
function matchSpaceName(_value: string, search: string, keywords?: string[]) {
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  return keywords?.some((keyword) => keyword.toLowerCase().includes(needle))
    ? 1
    : 0;
}

function ScopeIcon({ scope }: { scope: AgentSessionScopeGroup }) {
  if (scope.icon)
    return (
      <span className="flex size-4 items-center justify-center text-sm leading-none">
        {scope.icon}
      </span>
    );
  return scope.kind === "project" ? <Box /> : <FolderClosed />;
}
