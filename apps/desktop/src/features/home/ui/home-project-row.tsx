import { useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  Box,
  ChevronRight,
  Copy,
  Ellipsis,
  FolderOpen,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { revealInFileManagerLabel } from "@/features/external-open";
import type { SpaceInfo } from "@/features/space";
import { relativeTime } from "@/shared/lib/relative-time";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import {
  copyHomeProjectPath,
  revealHomeProjectFolder,
} from "../api/home-project-actions";
import { useHomeProjectExpanded } from "../hooks/use-home-project-expanded";
import { homeProjectUnavailableReason } from "../lib/home-project-reasons";
import type { HomeProjectAvailability } from "../model/home-projects";
import { RemoveProjectDialog } from "./remove-project-dialog";

interface HomeProjectRowProps {
  project: SpaceInfo;
  availability: HomeProjectAvailability;
  /** Another project of the list has the same name: the tooltip adds the path. */
  sharedName: boolean;
  onOpen: () => void;
  onStartChat: () => void;
  /** Search in the project, without entering or activating it. */
  onSearch: () => void;
  onRemove: (deleteFiles: boolean) => void;
  /** The rows under the expanded project; mounted only while expanded. */
  items: ReactNode;
}

/**
 * A project of the Home sidebar: its row enters the project's Space, its
 * chevron shows the project's objects under it. The rows below are siblings
 * of the project row, so hovering one reveals no actions of the other.
 */
export function HomeProjectRow({
  project,
  availability,
  sharedName,
  onOpen,
  onStartChat,
  onSearch,
  onRemove,
  items,
}: HomeProjectRowProps) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  // Search from the menu opens once focus is back on the menu trigger, so
  // closing Search returns focus there.
  const searchAfterMenu = useRef(false);
  const [expanded, setExpanded] = useHomeProjectExpanded(project.id);
  const otherWindow = availability === "otherWindow";
  const unavailable = availability === "missing" || availability === "broken";
  const reason = homeProjectUnavailableReason(availability);

  return (
    <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
      <li>
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton
                  type="button"
                  className={cn(
                    // The three actions show over the row's end on hover and focus.
                    "group-focus-within/menu-item:pr-20! group-hover/menu-item:pr-20!",
                    unavailable &&
                      "text-sidebar-foreground/50 hover:text-sidebar-foreground/50",
                  )}
                  onClick={onOpen}
                >
                  <span aria-hidden>{project.icon || <Box />}</span>
                  <span className="flex-1 truncate">{project.name}</span>
                </SidebarMenuButton>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="flex max-w-80 flex-col items-start gap-1 text-left"
              >
                <span className="font-medium">{project.name}</span>
                {project.description && <span>{project.description}</span>}
                {project.lastOpened && (
                  <span>
                    {m.home_project_opened({
                      time: relativeTime(project.lastOpened, getLocale()),
                    })}
                  </span>
                )}
                {sharedName && (
                  <span className="break-all">{project.path}</span>
                )}
                {reason && <span>{reason}</span>}
              </TooltipContent>
            </Tooltip>
            {otherWindow && (
              // The actions take the mark's place on hover, focus and while
              // the menu is open.
              <SidebarMenuBadge
                role="img"
                aria-label={m.home_project_other_window()}
                className="text-muted-foreground group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-[[aria-haspopup=menu][aria-expanded=true]]/menu-item:opacity-0"
              >
                <AppWindow className="size-3" />
              </SidebarMenuBadge>
            )}
            <CollapsibleTrigger asChild>
              <SidebarMenuAction
                type="button"
                showOnHover
                className="left-2 bg-sidebar-accent text-sidebar-accent-foreground data-[state=open]:rotate-90"
                aria-label={m.home_project_toggle({ project: project.name })}
              >
                <ChevronRight />
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction
                  ref={menuTrigger}
                  type="button"
                  showOnHover
                  className="right-13"
                  aria-label={m.home_project_actions({ project: project.name })}
                >
                  <Ellipsis />
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="bottom"
                onCloseAutoFocus={(event) => {
                  if (!searchAfterMenu.current) return;
                  searchAfterMenu.current = false;
                  event.preventDefault();
                  menuTrigger.current?.focus();
                  onSearch();
                }}
              >
                <DropdownMenuItem onSelect={onStartChat}>
                  <SquarePen />
                  {m.home_project_start_chat()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={unavailable}
                  onSelect={() => {
                    searchAfterMenu.current = true;
                  }}
                >
                  <Search />
                  <span className="min-w-0 flex-1 truncate">
                    {m.home_project_search()}
                  </span>
                  {unavailable && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {reason}
                    </span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void revealHomeProjectFolder(project.path).catch((err) =>
                      toast.error(m.external_open_project_error_default(), {
                        description: String(err),
                      }),
                    )
                  }
                >
                  <FolderOpen />
                  {revealInFileManagerLabel()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void copyHomeProjectPath(project.path).catch(() =>
                      toast.error(m.home_project_copy_path_failed()),
                    )
                  }
                >
                  <Copy />
                  {m.home_project_copy_path()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setRemoveOpen(true)}
                >
                  <Trash2 />
                  {m.project_remove()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <HomeProjectSearchAction
              project={project.name}
              unavailableReason={unavailable ? reason : null}
              onSearch={onSearch}
            />
            <SidebarMenuAction
              type="button"
              showOnHover
              aria-label={m.home_project_start_chat_in({
                project: project.name,
              })}
              onClick={onStartChat}
            >
              <SquarePen />
            </SidebarMenuAction>
            <RemoveProjectDialog
              open={removeOpen}
              onOpenChange={setRemoveOpen}
              onRemove={onRemove}
            />
          </SidebarMenuItem>
        </SidebarMenu>
        <CollapsibleContent>
          <SidebarMenuSub className="ml-4 border-l-0 pl-2">
            {items}
          </SidebarMenuSub>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

/**
 * Search in the project from its row; a project whose folder is missing or
 * unreadable keeps the button inactive with the reason under its row.
 */
function HomeProjectSearchAction({
  project,
  unavailableReason,
  onSearch,
}: {
  project: string;
  unavailableReason: string | null;
  onSearch: () => void;
}) {
  const action = (
    <SidebarMenuAction
      type="button"
      showOnHover
      className={cn(
        "right-7",
        unavailableReason &&
          "cursor-default text-sidebar-foreground/50 hover:bg-transparent hover:text-sidebar-foreground/50",
      )}
      aria-label={m.home_project_search_in({ project })}
      aria-disabled={unavailableReason ? true : undefined}
      onClick={unavailableReason ? undefined : onSearch}
    >
      <Search />
    </SidebarMenuAction>
  );
  if (!unavailableReason) return action;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{action}</TooltipTrigger>
      <TooltipContent side="right">{unavailableReason}</TooltipContent>
    </Tooltip>
  );
}
