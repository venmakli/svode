import { useState, type ReactNode } from "react";
import { Box, Check, ChevronDown, FolderClosed, SquarePen } from "lucide-react";
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
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacKeyboardPlatform } from "@/shared/lib/keyboard-shortcuts";
import {
  shortcutKeys,
  shortcutLabel,
  type ShortcutDescription,
} from "@/shared/lib/shortcut-description";
import { cn } from "@/shared/lib/utils";
import { useAgentSessionScopes, useNewSessionTarget } from "../hooks";
import {
  newSessionScopeChoices,
  type AgentSessionScopeGroup,
  type NewSessionSpaceRef,
  type NewSessionTarget,
} from "../model";
import * as m from "@/paraglide/messages.js";

const REVEAL_ON_ROW = cn(
  "opacity-0 transition-opacity motion-reduce:transition-none",
  "group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100",
);

interface NewSessionSidebarItemProps {
  /** Space of the main area object; null while it is not known. */
  space: NewSessionSpaceRef | null;
  /** The shortcut of the row, hinted on hover and focus. */
  shortcut: ShortcutDescription;
  onStart: (scope: AgentSessionScopeGroup) => void;
}

/**
 * "New session" of the main sidebar: the row starts a session in the Space
 * of the main area object, and the chevron after its name chooses any
 * available Space in a list under the row.
 */
export function NewSessionSidebarItem({
  space,
  shortcut,
  onStart,
}: NewSessionSidebarItemProps) {
  const scopes = useAgentSessionScopes();
  const target = useNewSessionTarget(space);
  const current = target.status === "ready" ? target.scope : null;
  const label = current
    ? m.sessions_new_in_space({ space: current.name })
    : m.sessions_action_new();

  return (
    <SpaceChooser
      choices={newSessionScopeChoices(scopes, current)}
      current={current}
      onChoose={onStart}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            type="button"
            className={cn(!current && "text-sidebar-foreground/50")}
            aria-label={label}
            aria-keyshortcuts={ariaKeyShortcuts(shortcut)}
            aria-disabled={!current || undefined}
            onClick={current ? () => onStart(current) : undefined}
          >
            <SquarePen />
            <span className="min-w-0 truncate">{m.sessions_action_new()}</span>
            {/* Room for the chevron, which sits over the row after the name. */}
            <span aria-hidden className="size-5 shrink-0" />
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">
          {current ? label : unavailableReason(target)}
        </TooltipContent>
      </Tooltip>
      <SidebarMenuBadge aria-hidden className={REVEAL_ON_ROW}>
        {shortcutLabel(shortcut)}
      </SidebarMenuBadge>
    </SpaceChooser>
  );
}

function ariaKeyShortcuts(shortcut: ShortcutDescription): string {
  const mac = isMacKeyboardPlatform();
  return shortcutKeys(shortcut, mac)
    .map((keys) =>
      keys
        .map((key) => (key === "Mod" ? (mac ? "Meta" : "Control") : key))
        .join("+"),
    )
    .join(" ");
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

/**
 * The row with its Space chooser: the list opens under the whole row, like
 * the other menus of the sidebar.
 */
function SpaceChooser({
  choices,
  current,
  onChoose,
  children,
}: {
  choices: AgentSessionScopeGroup[];
  current: AgentSessionScopeGroup | null;
  onChoose: (scope: AgentSessionScopeGroup) => void;
  /** The row itself; the chevron is laid over it right after its name. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <SidebarMenuItem>
          {children}
          {/*
           * Repeats the row's icon and name invisibly, so the chevron lands
           * right after the name whatever its length.
           */}
          <div className="pointer-events-none absolute inset-y-0 left-0 flex max-w-full items-center gap-2 p-2 text-sm">
            <span aria-hidden className="size-4 shrink-0" />
            <span aria-hidden className="invisible min-w-0 truncate">
              {m.sessions_action_new()}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={m.sessions_new_choose_space()}
                    className={cn(
                      "pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded-md text-sidebar-foreground ring-sidebar-ring outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 aria-expanded:opacity-100 [&>svg]:size-4",
                      REVEAL_ON_ROW,
                    )}
                  >
                    <ChevronDown />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {m.sessions_new_choose_space()}
              </TooltipContent>
            </Tooltip>
          </div>
        </SidebarMenuItem>
      </PopoverAnchor>
      <PopoverContent
        className="w-64 max-w-[calc(100vw-1rem)] p-0"
        side="bottom"
        align="start"
      >
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
