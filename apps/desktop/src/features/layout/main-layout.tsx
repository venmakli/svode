import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { unwatchSpace, watchSpace } from "@/platform/space/space-api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { AppSidebar } from "./app-sidebar";
import { WindowHeader } from "./window-header";
import { GitMissingDialog } from "./git-missing-dialog";
import { useGitAvailability } from "@/hooks/use-git-availability";
import { useAppGitFocus } from "@/features/workspace/use-app-git-focus";
import { SpaceGitWatcher } from "@/features/workspace/space-git-watcher";
import { useLayoutStore } from "@/stores/layout";
import { selectActiveSpacePath, useSpaceStore } from "@/stores/space";
import { EmptyProjectState } from "@/features/workspace/empty-project-state";
import { CommandPalette } from "@/features/search/command-palette";
import { TerminalPanelHost } from "@/features/terminal";
import type { TreeNode } from "@/types/space";
import { CollectionScreen, EntryDocumentScreen } from "@/features/collection";

function findNodeInTree(
  nodes: TreeNode[],
  targetPath: string,
): TreeNode | null {
  for (const node of nodes) {
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (node.path === targetPath || folderPath === targetPath) return node;
    const found = findNodeInTree(node.children, targetPath);
    if (found) return found;
  }
  return null;
}

function MainContent() {
  const { activeDocument, activeDocumentSpaceId } = useLayoutStore();
  const { fileTrees, rootSpaces, spaces, activeRootId, activeRootPath } =
    useSpaceStore();
  const watchSpacePath = useSpaceStore(selectActiveSpacePath);
  const documentSpaceId = activeDocumentSpaceId ?? activeRootId;
  const tree = documentSpaceId ? (fileTrees[documentSpaceId] ?? []) : [];
  const activeNode = activeDocument
    ? findNodeInTree(tree, activeDocument)
    : null;
  const activeSpace = documentSpaceId
    ? [...rootSpaces, ...spaces].find((space) => space.id === documentSpaceId)
    : null;
  const isCollection = Boolean(
    activeNode?.has_schema && activeSpace && documentSpaceId,
  );
  const usesEntryDocumentScreen = Boolean(
    !isCollection && activeSpace && documentSpaceId && activeDocument,
  );
  const activeContent =
    isCollection &&
    activeNode &&
    activeSpace &&
    documentSpaceId &&
    activeDocument ? (
      <CollectionScreen
        spacePath={activeSpace.path}
        projectPath={activeRootPath}
        documentPath={activeDocument}
        spaceId={documentSpaceId}
        hasReadme={activeNode.path.toLowerCase().endsWith(".md")}
      />
    ) : activeSpace && documentSpaceId && activeDocument ? (
      <EntryDocumentScreen
        spacePath={activeSpace.path}
        projectPath={activeRootPath}
        documentPath={activeDocument}
        spaceId={documentSpaceId}
      />
    ) : (
      <div className="h-full" />
    );

  useEffect(() => {
    if (!watchSpacePath) return;
    watchSpace(watchSpacePath).catch((error) =>
      console.error("Failed to watch space:", error),
    );
    return () => {
      unwatchSpace(watchSpacePath).catch((error) =>
        console.error("Failed to unwatch space:", error),
      );
    };
  }, [watchSpacePath]);

  if (!activeDocument) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden">
          <EmptyProjectState />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className={
          isCollection || usesEntryDocumentScreen
            ? "scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
            : "min-h-0 min-w-0 flex-1 overflow-hidden"
        }
      >
        {activeContent}
      </div>
    </div>
  );
}

export function MainLayout() {
  const navigate = useNavigate();
  useKeyboardShortcuts();
  useAppGitFocus();
  const {
    spaces,
    activeRootId,
    activeRootPath,
    fileTrees,
    openLastActiveRoot,
    explicitHome,
  } = useSpaceStore();
  const { available, recheck } = useGitAvailability();
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

  const hasChildren = spaces.length > 0;
  const rootTree = activeRootId ? (fileTrees[activeRootId] ?? []) : [];
  const hasDocuments = rootTree.length > 0;
  const isEmpty = !hasChildren && !hasDocuments;

  if (!activeRootId) {
    return <div className="h-dvh bg-background" />;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider className="min-h-0 h-dvh overflow-hidden">
        <WindowHeader />
        <AppSidebar />
        <SidebarInset className="pt-[44px] min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              {activeRootId && isEmpty ? (
                <EmptyProjectState />
              ) : (
                <MainContent />
              )}
            </div>
            <TerminalPanelHost />
          </div>
        </SidebarInset>
        {activeRootPath && <SpaceGitWatcher spacePath={activeRootPath} />}
        <GitMissingDialog open={available === false} onRecheck={recheck} />
        <CommandPalette />
      </SidebarProvider>
    </TooltipProvider>
  );
}
