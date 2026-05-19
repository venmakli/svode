import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { AppSidebar } from "./app-sidebar";
import { WindowHeader } from "./window-header";
import { GitMissingDialog } from "./git-missing-dialog";
import { useGitAvailability } from "@/hooks/use-git-availability";
import { useAppGitFocus } from "@/features/workspace/use-app-git-focus";
import { SpaceGitWatcher } from "@/features/workspace/space-git-watcher";
import { useLayoutStore } from "@/stores/layout";
import { selectActiveSpacePath, useSpaceStore } from "@/stores/space";
import { EmptyProjectState } from "@/features/workspace/empty-project-state";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import { ChatPanel } from "@/features/chat/chat-panel";
import { CommandPalette } from "@/features/search/command-palette";
import type { TreeNode } from "@/types/space";
import { CollectionScreen } from "@/features/collection";

function findNodeInTree(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (node.path === targetPath || folderPath === targetPath) return node;
    const found = findNodeInTree(node.children, targetPath);
    if (found) return found;
  }
  return null;
}

function MainContent() {
  const { activeDocument, activeDocumentSpaceId, chatPanelOpen } = useLayoutStore();
  const { fileTrees, rootSpaces, spaces, activeRootPath } = useSpaceStore();
  const watchSpacePath = useSpaceStore(selectActiveSpacePath);
  const tree = activeDocumentSpaceId ? fileTrees[activeDocumentSpaceId] ?? [] : [];
  const activeNode = activeDocument ? findNodeInTree(tree, activeDocument) : null;
  const activeSpace = activeDocumentSpaceId
    ? [...rootSpaces, ...spaces].find((space) => space.id === activeDocumentSpaceId)
    : null;
  const isCollection = Boolean(activeNode?.has_schema && activeSpace && activeDocumentSpaceId);
  const activeContent =
    isCollection && activeNode && activeSpace && activeDocumentSpaceId && activeDocument ? (
      <CollectionScreen
        spacePath={activeSpace.path}
        projectPath={activeRootPath}
        documentPath={activeDocument}
        spaceId={activeDocumentSpaceId}
        hasReadme={activeNode.path.toLowerCase().endsWith(".md")}
      />
    ) : (
      <PlateDocumentEditor />
    );

  useEffect(() => {
    if (!watchSpacePath) return;
    invoke("watch_space", { space: watchSpacePath }).catch((error) =>
      console.error("Failed to watch space:", error),
    );
    return () => {
      invoke("unwatch_space", { space: watchSpacePath }).catch((error) =>
        console.error("Failed to unwatch space:", error),
      );
    };
  }, [watchSpacePath]);

  if (!activeDocument) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatPanel />
        </div>
      </div>
    );
  }

  if (!chatPanelOpen) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div
          className={
            isCollection
              ? "scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
              : "min-h-0 min-w-0 flex-1 overflow-hidden"
          }
        >
          {activeContent}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize="65%">
          <div
            className={
              isCollection
                ? "scrollbar-hide h-full overflow-y-auto overflow-x-hidden"
                : "h-full overflow-hidden"
            }
          >
            {activeContent}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="35%">
          <div className="h-full overflow-hidden">
            <ChatPanel />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
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
  const rootTree = activeRootId ? fileTrees[activeRootId] ?? [] : [];
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
          {activeRootId && isEmpty ? (
            <EmptyProjectState />
          ) : (
            <MainContent />
          )}
        </SidebarInset>
        {activeRootPath && <SpaceGitWatcher spacePath={activeRootPath} />}
        <GitMissingDialog open={available === false} onRecheck={recheck} />
        <CommandPalette />
      </SidebarProvider>
    </TooltipProvider>
  );
}
