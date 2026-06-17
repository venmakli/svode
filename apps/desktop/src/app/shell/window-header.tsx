import { useLayoutEffect, useRef } from "react";
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

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.platform.toLowerCase().includes("mac") ||
    /macintosh|mac os x/i.test(navigator.userAgent)
  );
}

export function ShellChrome() {
  const { state, toggleSidebar } = useSidebar();
  const isFullscreen = useFullscreen();
  const chromeRef = useRef<HTMLDivElement>(null);
  const sidebarHidden = state === "collapsed";
  const reserveTrafficLights = isMacPlatform() && !isFullscreen;

  useLayoutEffect(() => {
    const node = chromeRef.current;
    const shell = node?.parentElement;
    if (!node || !shell) return;

    const updateWidth = () => {
      shell.style.setProperty(
        "--shell-chrome-width",
        `${Math.ceil(node.getBoundingClientRect().width)}px`,
      );
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);

    return () => {
      observer.disconnect();
      shell.style.removeProperty("--shell-chrome-width");
    };
  }, []);

  return (
    <div
      ref={chromeRef}
      data-tauri-drag-region
      className={cn(
        "absolute left-0 top-0 z-30 flex h-[44px] w-max max-w-[var(--sidebar-width)] min-w-0 items-center gap-1 bg-sidebar pr-2 transition-colors",
        sidebarHidden && "bg-transparent",
        reserveTrafficLights ? "pl-[72px]" : "pl-2",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(reserveTrafficLights && "ml-3")}
            onClick={toggleSidebar}
          >
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Toggle sidebar (⌘\)</TooltipContent>
      </Tooltip>
      <ProjectSwitcher className="w-fit min-w-0 max-w-full" />
    </div>
  );
}

export function WindowHeader() {
  const activeDocument = useEntrySelectionStore((state) => state.activeDocument);
  const toggleChatPanel = useShellStore((state) => state.toggleChatPanel);
  const { activeRootId, activeRootName, activeRootPath } = useSpaceStore();
  const { state } = useSidebar();
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
      style={
        sidebarHidden
          ? { paddingLeft: "calc(var(--shell-chrome-width, 220px) - 1rem)" }
          : undefined
      }
      className={cn(
        "flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-transparent pr-2 transition-[padding-left] duration-200 ease-linear",
        !sidebarHidden && "pl-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
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
