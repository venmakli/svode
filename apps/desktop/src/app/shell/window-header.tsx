import { useMatches } from "@tanstack/react-router";
import { PanelLeft, PanelRight } from "lucide-react";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space";
import { useFullscreen } from "./hooks/use-fullscreen";
import { useShellStore } from "./model";
import { cn } from "@/shared/lib/utils";
import { CloudUploadButton } from "@/features/git";
import { buildProjectTerminalTarget } from "@/features/terminal";
import { MainBreadcrumbs } from "@/features/space";
import { ProjectOpenersMenu } from "./project-openers-menu";
import { ProjectSwitcher } from "./project-switcher";

export function SidebarHeaderChrome() {
  const { toggleSidebar } = useSidebar();
  const isFullscreen = useFullscreen();

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-[44px] min-w-0 items-center gap-2",
        isFullscreen ? "pl-0" : "pl-[72px]",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Toggle sidebar (⌘\)</TooltipContent>
      </Tooltip>
      <ProjectSwitcher />
    </div>
  );
}

export function WindowHeader() {
  const activeDocument = useEntrySelectionStore((state) => state.activeDocument);
  const toggleChatPanel = useShellStore((state) => state.toggleChatPanel);
  const { activeRootId, activeRootName, activeRootPath } = useSpaceStore();
  const { state, toggleSidebar } = useSidebar();
  const isFullscreen = useFullscreen();
  const matches = useMatches();

  const chatToggleDisabled = !activeDocument;
  const terminalTarget = buildProjectTerminalTarget({
    id: activeRootId,
    name: activeRootName,
    path: activeRootPath,
  });

  // Check if we're on the /space route
  const isSpaceRoute = matches.some((match) => match.fullPath === "/space");
  const sidebarHidden = state === "collapsed";

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-transparent pr-2",
        sidebarHidden && !isFullscreen ? "pl-[80px]" : "pl-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {sidebarHidden && (
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
                  <PanelLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Toggle sidebar (⌘\)</TooltipContent>
            </Tooltip>
            <ProjectSwitcher />
          </div>
        )}
        {isSpaceRoute && <MainBreadcrumbs />}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isSpaceRoute && <CloudUploadButton />}
        {isSpaceRoute && (
          <ProjectOpenersMenu
            projectPath={activeRootPath}
            terminalTarget={terminalTarget}
          />
        )}
        {ENABLE_IN_APP_CHAT && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleChatPanel}
                disabled={chatToggleDisabled}
              >
                <PanelRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle chat panel (⌘R)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
