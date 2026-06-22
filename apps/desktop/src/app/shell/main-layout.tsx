import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { ShellChrome, WindowHeader } from "./window-header";
import {
  CommandPalette,
  useOpenCommandPalette,
} from "@/features/search/app-shell";
import { TerminalPanelHost } from "@/features/terminal";
import { useSpace, useSpaceActions } from "@/features/space";
import { SpaceFileWatcher, SpaceSidebar } from "@/features/space/app-shell";
import {
  GitMissingDialog,
  SpaceGitWatcher,
  useAppGitFocus,
  useGitAvailability,
} from "@/features/git/app-shell";
import { avatarColorFromEmail } from "@/features/identity";
import { useEffectiveIdentity } from "@/features/identity/app-shell";
import { useShellStore } from "./model";
import { InboxSurface, SessionsSurface } from "./main-surfaces";
import { ActiveSpaceContent } from "./active-space-content";

export function MainLayout() {
  const navigate = useNavigate();
  useKeyboardShortcuts();
  useAppGitFocus();
  const { activeRootId, activeRootPath, explicitHome } = useSpace();
  const { openLastActiveRoot } = useSpaceActions();
  const { available, recheck } = useGitAvailability();
  const { name: identityName, email: identityEmail } = useEffectiveIdentity();
  const openAppSettings = useShellStore((state) => state.openAppSettings);
  const openSpaceSettings = useShellStore((state) => state.openSpaceSettings);
  const mainSurface = useShellStore((state) => state.mainSurface);
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const openInboxSurface = useShellStore((state) => state.openInboxSurface);
  const openSessionsSurface = useShellStore(
    (state) => state.openSessionsSurface,
  );
  const setCommandPaletteOpen = useOpenCommandPalette();
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    openContentSurface();
  }, [openContentSurface]);

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
      <SidebarProvider className="relative min-h-0 h-dvh overflow-hidden bg-sidebar">
        <ShellChrome />
        <SpaceSidebar
          identityName={identityName}
          identityEmail={identityEmail}
          identityAvatarColor={avatarColorFromEmail(identityEmail)}
          mainSurface={mainSurface}
          onActivateContent={openContentSurface}
          onOpenInbox={openInboxSurface}
          onOpenSessions={openSessionsSurface}
          onOpenSearch={() => setCommandPaletteOpen(true)}
          onOpenAppSettings={openAppSettings}
          onOpenSpaceSettings={openSpaceSettings}
        />
        <SidebarInset className="min-h-0 overflow-hidden md:peer-data-[state=expanded]:rounded-l-xl md:peer-data-[state=expanded]:border-l md:peer-data-[state=expanded]:border-sidebar-border">
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
