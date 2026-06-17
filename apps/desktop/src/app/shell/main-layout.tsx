import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { SidebarHeaderChrome, WindowHeader } from "./window-header";
import { useSpaceStore } from "@/features/space";
import { CommandPalette, useCommandPaletteStore } from "@/features/search";
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
import { InboxSurface, SessionsSurface } from "./main-surfaces";

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
  const mainSurface = useShellStore((state) => state.mainSurface);
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const openInboxSurface = useShellStore((state) => state.openInboxSurface);
  const openSessionsSurface = useShellStore(
    (state) => state.openSessionsSurface,
  );
  const setCommandPaletteOpen = useCommandPaletteStore((state) => state.setOpen);
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
        <SpaceSidebar
          header={<SidebarHeaderChrome />}
          mainSurface={mainSurface}
          onActivateContent={openContentSurface}
          onOpenInbox={openInboxSurface}
          onOpenSessions={openSessionsSurface}
          onOpenSearch={() => setCommandPaletteOpen(true)}
          onOpenAppSettings={openAppSettings}
          onOpenSpaceSettings={openSpaceSettings}
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          <WindowHeader />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              {mainSurface === "inbox" ? (
                <InboxSurface />
              ) : mainSurface === "sessions" ? (
                <SessionsSurface />
              ) : (
                <ActiveSpaceContent />
              )}
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
