import { useNavigate, useMatches } from "@tanstack/react-router";
import { Home, PanelLeft, PanelRight, Search } from "lucide-react";
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
import { useCommandPaletteStore } from "@/features/search";
import { buildProjectTerminalTarget } from "@/features/terminal";
import * as m from "@/paraglide/messages.js";
import { MainBreadcrumbs } from "@/features/space";
import { ProjectOpenersMenu } from "./project-openers-menu";

export function WindowHeader() {
  const activeDocument = useEntrySelectionStore((state) => state.activeDocument);
  const toggleChatPanel = useShellStore((state) => state.toggleChatPanel);
  const { activeRootId, activeRootName, activeRootPath, goHome } =
    useSpaceStore();
  const setCommandPaletteOpen = useCommandPaletteStore((s) => s.setOpen);
  const { toggleSidebar } = useSidebar();
  const isFullscreen = useFullscreen();
  const navigate = useNavigate();
  const matches = useMatches();

  const chatToggleDisabled = !activeDocument;
  const terminalTarget = buildProjectTerminalTarget({
    id: activeRootId,
    name: activeRootName,
    path: activeRootPath,
  });

  // Check if we're on the /space route
  const isSpaceRoute = matches.some((match) => match.fullPath === "/space");

  function handleGoHome() {
    goHome();
    navigate({ to: "/" });
  }

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "fixed top-0 left-0 right-0 z-20 flex h-[44px] items-center justify-between gap-2 pr-2",
        isFullscreen ? "pl-2" : "pl-[80px]",
      )}
    >
      {/* Left: sidebar toggle + home button */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
                <PanelLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle sidebar (⌘\)</TooltipContent>
          </Tooltip>

          {isSpaceRoute && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={handleGoHome}>
                  <Home className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {m.nav_all_projects()} ({"\u2318\u21E7"}O)
              </TooltipContent>
            </Tooltip>
          )}

          {isSpaceRoute && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCommandPaletteOpen(true)}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {m.search_tooltip()} ({"\u2318"}P)
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {isSpaceRoute && <MainBreadcrumbs />}
      </div>

      {/* Right: cloud upload + external openers + chat panel toggle */}
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
                <PanelRight className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle chat panel (⌘R)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
