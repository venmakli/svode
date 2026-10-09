import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { sidebarShortcut } from "./model/shortcut-descriptions";
import { ChangesControl } from "@/features/changes";
import { useLayoutEffect, useRef } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveContentSelection } from "@/features/artifact";
import { selectActiveSpacePath, useSpace } from "@/features/space";
import { useTrafficLightInset } from "./hooks/use-fullscreen";
import { useShellStore } from "./model";
import { cn } from "@/shared/lib/utils";
import { GitSyncStatusWidget } from "@/features/git/app-shell";
import { MainBreadcrumbs } from "@/features/space/app-shell";
import { ProjectExternalOpenButton } from "@/features/external-open";
import { HomeSidebarHeader } from "@/features/home";
import { KnowledgeGraphBreadcrumb } from "@/features/knowledge";
import { ViewToolsGroup } from "@/shared/ui/view-tools-group";
import { useMainHeaderContribution } from "./main-header-contribution";
import { ProjectSwitcher } from "./project-switcher";
import { useShellView } from "./shell-view";
import { passNavigationGuards } from "./navigation-guards";
import {
  useAgentSessionSpace,
  useResolvedAgentSession,
} from "@/features/agent-sessions";

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.platform.toLowerCase().includes("mac") ||
    /macintosh|mac os x/i.test(navigator.userAgent)
  );
}

export function ShellChrome() {
  const { state, toggleSidebar } = useSidebar();
  const trafficLightInsetReserved = useTrafficLightInset();
  const chromeRef = useRef<HTMLDivElement>(null);
  const sidebarHidden = state === "collapsed";
  const isMac = isMacPlatform();
  const reserveTrafficLights = isMac && trafficLightInsetReserved;
  const sidebarShortcutLabel = shortcutLabel(sidebarShortcut);
  const view = useShellView();

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
        "absolute left-0 top-0 z-30 flex h-[44px] min-w-0 items-center gap-1 bg-sidebar pr-2 transition-[padding-left,background-color] duration-200 ease-out motion-reduce:transition-none",
        sidebarHidden
          ? "w-max max-w-[var(--sidebar-width)]"
          : "w-[var(--sidebar-width)]",
        sidebarHidden && "bg-transparent",
        reserveTrafficLights ? "pl-[84px]" : "pl-2",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sidebarShortcut.label()} ({sidebarShortcutLabel})
        </TooltipContent>
      </Tooltip>
      {view === "home" ? (
        <HomeSidebarHeader />
      ) : (
        <ProjectSwitcher className="min-w-0 flex-1" />
      )}
    </div>
  );
}

/**
 * The main top bar: `[breadcrumbs] ⓘ ⋯ ··· [view tools] · Changes · Git sync ·
 * Open with`. The open main surface contributes its parts through
 * `usePublishMainHeader`; the header owns their order and narrow-width
 * behavior: the breadcrumbs shrink first, then the view tools collapse.
 */
export function WindowHeader() {
  const contribution = useMainHeaderContribution();
  const { selection } = useActiveContentSelection();
  const mainSurface = useShellStore((state) => state.mainSurface);
  const mainSessionTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const mainSession = useResolvedAgentSession(mainSessionTarget);
  const mainSessionSpace = useAgentSessionSpace(mainSession);
  const openSpaceSettings = useShellStore((state) => state.openSpaceSettings);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const activeSpacePath = useSpace(selectActiveSpacePath);
  const { state } = useSidebar();
  const view = useShellView();

  // Home without an active project shows no project chrome.
  const projectShown = activeRootPath !== null;
  const showBreadcrumbs = projectShown && mainSurface === "content";
  // A session shows Git sync and changes of its own Space only.
  const sessionSpace =
    projectShown && mainSessionSpace?.ready ? mainSessionSpace : null;
  const showGitSync =
    projectShown &&
    (!mainSessionTarget || sessionSpace?.spacePath === activeSpacePath);
  const sidebarHidden = state === "collapsed";
  const changesTarget = contribution?.changes;
  const objectActions = projectShown ? contribution?.objectActions : null;
  const viewTools = projectShown ? contribution?.viewTools : null;

  return (
    <header
      data-tauri-drag-region
      style={
        sidebarHidden
          ? { paddingLeft: "calc(var(--shell-chrome-width, 220px) - 1rem)" }
          : undefined
      }
      className={cn(
        "flex h-[44px] shrink-0 items-center gap-2 border-b border-transparent pr-2 transition-[padding-left] duration-200 ease-linear",
        !sidebarHidden && "pl-2",
      )}
    >
      <div
        data-main-header-object
        className="flex min-w-0 shrink-[10000] items-center gap-1 has-[[data-slot=breadcrumb]]:min-w-32"
      >
        {showBreadcrumbs && (
          <MainBreadcrumbs
            home={view === "home"}
            onBeforeNavigation={passNavigationGuards}
          />
        )}
        {projectShown && contribution?.breadcrumbs}
        {projectShown && mainSurface === "graph" && (
          <KnowledgeGraphBreadcrumb />
        )}
        {objectActions ? (
          <div className="flex shrink-0 items-center gap-1">
            {objectActions}
          </div>
        ) : null}
      </div>

      {viewTools ? (
        <ViewToolsGroup>{viewTools}</ViewToolsGroup>
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex shrink-0 items-center gap-1">
        {projectShown &&
        mainSurface === "content" &&
        changesTarget?.name &&
        changesTarget.spacePath &&
        selection &&
        changesTarget.sessionKey ===
          (selection.kind === "artifact"
            ? selection.request.sessionKey
            : selection.request.key) &&
        changesTarget.spacePath === activeSpacePath ? (
          <ChangesControl
            key={
              selection?.kind === "artifact"
                ? selection.request.sessionKey
                : selection.request.key
            }
            target={changesTarget}
          />
        ) : null}
        {sessionSpace ? (
          <ChangesControl
            target={{
              kind: sessionSpace.spaceId ? "space" : "project",
              sourceShape: "directory",
              spacePath: sessionSpace.spacePath,
              projectPath: activeRootPath,
              path: "",
              name: sessionSpace.name,
            }}
          />
        ) : null}
        {showGitSync && (
          <GitSyncStatusWidget
            activateAccess={mainSurface === "content"}
            onOpenRepositorySettings={(repositoryPath) =>
              openSpaceSettings(repositoryPath, "git")
            }
          />
        )}
        {activeRootPath ? (
          <ProjectExternalOpenButton
            projectPath={activeRootPath}
            objectGroup={contribution?.openWith}
          />
        ) : null}
      </div>
    </header>
  );
}
