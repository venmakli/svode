import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { WindowHeader } from "./window-header";
import { useSpaceStore } from "@/features/space";
import { CommandPalette } from "@/features/search/command-palette";
import { TerminalPanelHost } from "@/features/terminal";
import {
  ActiveSpaceContent,
  SpaceFileWatcher,
  SpaceSidebar,
} from "@/features/space";
import {
  GitMissingDialog,
  SpaceGitWatcher,
  useAppGitFocus,
  useGitAvailability,
} from "@/features/git";
import { useShellStore } from "./model";

export function MainLayout() {
  const navigate = useNavigate();
  useKeyboardShortcuts();
  useAppGitFocus();
  const {
    activeRootId,
    activeRootPath,
    openLastActiveRoot,
    explicitHome,
  } = useSpaceStore();
  const { available, recheck } = useGitAvailability();
  const openAppSettings = useShellStore((state) => state.openAppSettings);
  const openSpaceSettings = useShellStore((state) => state.openSpaceSettings);
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    if (activeRootId || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;

    (async () => {
      if (explicitHome) {
        navigate({ to: "/" });
        return;
      }

      const opened = await openLastActiveRoot();
      if (!opened) {
        navigate({ to: "/" });
      }
    })();
  }, [activeRootId, explicitHome, navigate, openLastActiveRoot]);

  if (!activeRootId) {
    return <div className="h-dvh bg-background" />;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider className="min-h-0 h-dvh overflow-hidden">
        <WindowHeader />
        <SpaceSidebar
          onOpenAppSettings={openAppSettings}
          onOpenSpaceSettings={openSpaceSettings}
        />
        <SidebarInset className="pt-[44px] min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ActiveSpaceContent />
            </div>
            <TerminalPanelHost />
          </div>
        </SidebarInset>
        <SpaceFileWatcher />
        {activeRootPath && <SpaceGitWatcher spacePath={activeRootPath} />}
        <GitMissingDialog open={available === false} onRecheck={recheck} />
        <CommandPalette />
      </SidebarProvider>
    </TooltipProvider>
  );
}
