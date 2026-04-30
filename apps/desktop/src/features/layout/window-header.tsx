import { useNavigate, useMatches } from "@tanstack/react-router";
import { Home, PanelLeft, PanelRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { useLayoutStore } from "@/stores/layout";
import { useSpaceStore } from "@/stores/space";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { cn } from "@/lib/utils";
import { CloudUploadButton } from "@/features/workspace/cloud-upload-button";
import { useCommandPaletteStore } from "@/features/search/store";
import * as m from "@/paraglide/messages.js";

export function WindowHeader() {
  const { activeDocument, toggleChatPanel } = useLayoutStore();
  const { goHome } = useSpaceStore();
  const setCommandPaletteOpen = useCommandPaletteStore((s) => s.setOpen);
  const { toggleSidebar } = useSidebar();
  const isFullscreen = useFullscreen();
  const navigate = useNavigate();
  const matches = useMatches();

  const chatToggleDisabled = !activeDocument;

  // Check if we're on the /space route
  const isSpaceRoute = matches.some(
    (match) => match.fullPath === "/space",
  );

  function handleGoHome() {
    goHome();
    navigate({ to: "/" });
  }

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "fixed top-0 left-0 right-0 z-20 flex h-[44px] items-center justify-between pr-2",
        isFullscreen ? "pl-2" : "pl-[80px]",
      )}
    >
      {/* Left: sidebar toggle + home button */}
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Toggle sidebar (⌘\)</TooltipContent>
        </Tooltip>

        {isSpaceRoute && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleGoHome}
              >
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

      {/* Right: cloud upload + chat panel toggle */}
      <div className="flex items-center">
        {isSpaceRoute && <CloudUploadButton />}
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
      </div>
    </header>
  );
}
