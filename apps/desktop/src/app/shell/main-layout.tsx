import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
import {
  SHELL_SIDEBAR_WIDTH_DEFAULT,
  SHELL_SIDEBAR_WIDTH_MAX,
  SHELL_SIDEBAR_WIDTH_MIN,
  useShellStore,
} from "./model";
import { InboxSurface, SessionsSurface } from "./main-surfaces";
import { ActiveSpaceContent } from "./active-space-content";
import { cn } from "@/shared/lib/utils";

type SidebarProviderStyle = CSSProperties & {
  "--sidebar-width": string;
};

interface ShellLayoutContentProps {
  sidebarProviderRef: RefObject<HTMLDivElement | null>;
  identityName: string | null;
  identityEmail: string | null;
  mainSurface: "content" | "inbox" | "sessions";
  onActivateContent: () => void;
  onOpenInbox: () => void;
  onOpenSessions: () => void;
  onOpenSearch: () => void;
  onOpenAppSettings: () => void;
}

interface DesktopResizableShellProps {
  sidebarProviderRef: RefObject<HTMLDivElement | null>;
  sidebar: ReactNode;
  mainSurface: "content" | "inbox" | "sessions";
}

export function MainLayout() {
  const navigate = useNavigate();
  useKeyboardShortcuts();
  useAppGitFocus();
  const { activeRootId, activeRootPath, explicitHome } = useSpace();
  const { openLastActiveRoot } = useSpaceActions();
  const { available, recheck } = useGitAvailability();
  const { name: identityName, email: identityEmail } = useEffectiveIdentity();
  const openAppSettings = useShellStore((state) => state.openAppSettings);
  const mainSurface = useShellStore((state) => state.mainSurface);
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const openInboxSurface = useShellStore((state) => state.openInboxSurface);
  const openSessionsSurface = useShellStore(
    (state) => state.openSessionsSurface,
  );
  const sidebarWidth = useShellStore((state) => state.sidebarWidth);
  const setCommandPaletteOpen = useOpenCommandPalette();
  const bootstrapAttempted = useRef(false);
  const sidebarProviderRef = useRef<HTMLDivElement | null>(null);
  const sidebarProviderStyle = useMemo<SidebarProviderStyle>(
    () => ({
      "--sidebar-width": `${sidebarWidth}px`,
    }),
    [sidebarWidth],
  );

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
      <SidebarProvider
        ref={sidebarProviderRef}
        style={sidebarProviderStyle}
        className="relative min-h-0 h-dvh overflow-hidden bg-sidebar"
      >
        <ShellLayoutContent
          sidebarProviderRef={sidebarProviderRef}
          identityName={identityName}
          identityEmail={identityEmail}
          mainSurface={mainSurface}
          onActivateContent={openContentSurface}
          onOpenInbox={openInboxSurface}
          onOpenSessions={openSessionsSurface}
          onOpenSearch={() => setCommandPaletteOpen(true)}
          onOpenAppSettings={openAppSettings}
        />
        <SpaceFileWatcher />
        {activeRootPath && <SpaceGitWatcher spacePath={activeRootPath} />}
        <GitMissingDialog open={available === false} onRecheck={recheck} />
        <CommandPalette />
      </SidebarProvider>
    </TooltipProvider>
  );
}

function ShellLayoutContent({
  sidebarProviderRef,
  identityName,
  identityEmail,
  mainSurface,
  onActivateContent,
  onOpenInbox,
  onOpenSessions,
  onOpenSearch,
  onOpenAppSettings,
}: ShellLayoutContentProps) {
  const { state, isMobile } = useSidebar();
  const sidebarHidden = state === "collapsed";
  const useResizableSidebar = !isMobile && !sidebarHidden;

  const sidebar = (
    <SpaceSidebar
      identityName={identityName}
      identityEmail={identityEmail}
      identityAvatarColor={avatarColorFromEmail(identityEmail)}
      mainSurface={mainSurface}
      onActivateContent={onActivateContent}
      onOpenInbox={onOpenInbox}
      onOpenSessions={onOpenSessions}
      onOpenSearch={onOpenSearch}
      onOpenAppSettings={onOpenAppSettings}
    />
  );

  if (!useResizableSidebar) {
    return (
      <>
        <ShellChrome />
        {sidebar}
        <ShellMainInset mainSurface={mainSurface} />
      </>
    );
  }

  return (
    <>
      <ShellChrome />
      <DesktopResizableShell
        sidebarProviderRef={sidebarProviderRef}
        sidebar={sidebar}
        mainSurface={mainSurface}
      />
    </>
  );
}

function DesktopResizableShell({
  sidebarProviderRef,
  sidebar,
  mainSurface,
}: DesktopResizableShellProps) {
  const [initialSidebarWidth] = useState(
    () => useShellStore.getState().sidebarWidth,
  );
  const liveSidebarWidthRef = useRef(initialSidebarWidth);
  const initialWidthRestoredRef = useRef(
    initialSidebarWidth === SHELL_SIDEBAR_WIDTH_DEFAULT,
  );
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const commitSidebarWidth = useShellStore(
    (store) => store.commitSidebarWidth,
  );

  useLayoutEffect(() => {
    if (initialSidebarWidth === SHELL_SIDEBAR_WIDTH_DEFAULT) return;

    liveSidebarWidthRef.current = initialSidebarWidth;
    sidebarPanelRef.current?.resize(initialSidebarWidth);
    initialWidthRestoredRef.current = true;
  }, [initialSidebarWidth]);

  return (
    <ResizablePanelGroup
      id="svode-main-layout"
      orientation="horizontal"
      className="min-h-0 flex-1"
      onLayoutChanged={() => {
        if (!initialWidthRestoredRef.current) return;

        commitSidebarWidth(liveSidebarWidthRef.current);
      }}
    >
      <ResizablePanel
        id="svode-sidebar-panel"
        panelRef={sidebarPanelRef}
        className="[&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none"
        defaultSize={SHELL_SIDEBAR_WIDTH_DEFAULT}
        minSize={SHELL_SIDEBAR_WIDTH_MIN}
        maxSize={SHELL_SIDEBAR_WIDTH_MAX}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          if (size.inPixels > 0) {
            const sidebarWidth = Math.round(size.inPixels);
            liveSidebarWidthRef.current = sidebarWidth;
            sidebarProviderRef.current?.style.setProperty(
              "--sidebar-width",
              `${sidebarWidth}px`,
            );
          }
        }}
        style={{ overflow: "visible" }}
      >
        {sidebar}
      </ResizablePanel>
      <ResizableHandle
        aria-label="Resize sidebar"
        title="Resize sidebar"
        className="cursor-col-resize bg-transparent after:w-2 hover:bg-transparent focus-visible:ring-0 focus-visible:ring-transparent data-[separator=active]:bg-transparent data-[separator=hover]:bg-transparent"
      />
      <ResizablePanel
        id="svode-main-panel"
        minSize={360}
        style={{ overflow: "hidden" }}
      >
        <ShellMainInset mainSurface={mainSurface} resizable />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ShellMainInset({
  mainSurface,
  resizable = false,
}: {
  mainSurface: "content" | "inbox" | "sessions";
  resizable?: boolean;
}) {
  return (
    <SidebarInset
      className={cn(
        "min-h-0 overflow-hidden [--svode-main-fixed-left:1.5rem]",
        resizable
          ? "h-full w-full [--svode-main-fixed-left:calc(var(--sidebar-width)+1.5rem)] rounded-l-xl border-l border-sidebar-border"
          : "md:peer-data-[state=expanded]:[--svode-main-fixed-left:calc(var(--sidebar-width)+1.5rem)] md:peer-data-[state=expanded]:rounded-l-xl md:peer-data-[state=expanded]:border-l md:peer-data-[state=expanded]:border-sidebar-border",
      )}
    >
      <WindowHeader />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden pb-6">
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
  );
}
