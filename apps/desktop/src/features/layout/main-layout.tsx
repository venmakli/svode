import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar";
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
import { useSpaceStore } from "@/stores/space";
import { EmptyProjectState } from "@/features/workspace/empty-project-state";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import { ChatPanel } from "@/features/chat/chat-panel";
import { CommandPalette } from "@/features/search/command-palette";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TreeNode } from "@/types/space";
import { CollectionScreen } from "@/features/collection/screen";


/** Look up the title for a path segment from the tree. */
function findTitleInTree(
  nodes: TreeNode[],
  targetPath: string,
): string | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node.title;
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (folderPath === targetPath) return node.title;
    if (node.children.length > 0) {
      const found = findTitleInTree(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

/** Build breadcrumb segments from a document path. */
function buildSegments(
  docPath: string,
  tree: TreeNode[],
): { label: string; path: string }[] {
  const parts = docPath.split("/");
  const segments: { label: string; path: string }[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const cumPath = parts.slice(0, i + 1).join("/");

    if (i === parts.length - 1 && part.toLowerCase() === "readme.md") continue;

    if (i < parts.length - 1) {
      const title = findTitleInTree(tree, cumPath) ?? part;
      segments.push({ label: title, path: cumPath + "/readme.md" });
    } else {
      const title =
        findTitleInTree(tree, cumPath) ?? part.replace(/\.md$/, "");
      segments.push({ label: title, path: cumPath });
    }
  }

  return segments;
}

function findNodeInTree(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (node.path === targetPath || folderPath === targetPath) return node;
    const found = findNodeInTree(node.children, targetPath);
    if (found) return found;
  }
  return null;
}

function MainBreadcrumbs() {
  const { activeDocument, activeDocumentSpaceId } = useLayoutStore();
  const { rootSpaces, spaces, fileTrees, openSpace } =
    useSpaceStore();
  const { openDocument } = useLayoutStore();

  if (!activeDocument) return null;

  const allSpaces = [...rootSpaces, ...spaces];
  const activeWorkspace = activeDocumentSpaceId
    ? allSpaces.find((w) => w.id === activeDocumentSpaceId)
    : null;
  const workspaceName = activeWorkspace
    ? `${activeWorkspace.icon} ${activeWorkspace.name}`
    : "";

  const treeId = activeDocumentSpaceId;
  const tree = treeId ? fileTrees[treeId] ?? [] : [];
  const segments = buildSegments(activeDocument, tree);

  const MAX_VISIBLE = 3;
  const needsEllipsis = segments.length > MAX_VISIBLE;
  const visibleSegments = needsEllipsis
    ? [segments[0], ...segments.slice(-2)]
    : segments;

  return (
    <div className="border-b px-4 py-1.5">
      <Breadcrumb>
        <BreadcrumbList>
          {workspaceName && (
            <>
              <BreadcrumbItem className="text-sm">
                  <WorkspaceBreadcrumb
                    label={workspaceName}
                    workspaces={allSpaces}
                    onSwitch={openSpace}
                  />
              </BreadcrumbItem>
              {segments.length > 0 && <BreadcrumbSeparator />}
            </>
          )}
          {visibleSegments.map((seg, i) => (
            <span key={seg.path} className="contents">
              {i === 1 && needsEllipsis && (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbEllipsis />
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                </>
              )}
              <BreadcrumbItem className="text-sm">
                <button
                  className="hover:text-foreground transition-colors cursor-pointer"
                  onClick={() => openDocument(seg.path, treeId ?? undefined)}
                >
                  {seg.label}
                </button>
              </BreadcrumbItem>
              {i < visibleSegments.length - 1 && <BreadcrumbSeparator />}
            </span>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}

function WorkspaceBreadcrumb({
  label,
  workspaces,
  onSwitch,
}: {
  label: string;
  workspaces: { id: string; name: string; icon: string }[];
  onSwitch: (id: string) => void;
}) {
  const { state } = useSidebar();
  const isSidebarCollapsed = state === "collapsed";

  if (!isSidebarCollapsed || workspaces.length <= 1) {
    return <span>{label}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="hover:text-foreground transition-colors cursor-pointer">
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {workspaces.map((ws) => (
          <DropdownMenuItem key={ws.id} onClick={() => onSwitch(ws.id)}>
            <span className="mr-2">{ws.icon}</span>
            {ws.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MainContent() {
  const { activeDocument, activeDocumentSpaceId, chatPanelOpen } = useLayoutStore();
  const { fileTrees, rootSpaces, spaces, activeRootPath } = useSpaceStore();
  const tree = activeDocumentSpaceId ? fileTrees[activeDocumentSpaceId] ?? [] : [];
  const activeNode = activeDocument ? findNodeInTree(tree, activeDocument) : null;
  const activeSpace = activeDocumentSpaceId
    ? [...rootSpaces, ...spaces].find((space) => space.id === activeDocumentSpaceId)
    : null;
  const isCollection = Boolean(activeNode?.has_schema && activeSpace && activeDocumentSpaceId);

  if (!activeDocument) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <MainBreadcrumbs />
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatPanel />
        </div>
      </div>
    );
  }

  if (!chatPanelOpen) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <MainBreadcrumbs />
        <div className="flex-1 min-w-0 min-h-0">
          {isCollection && activeNode && activeSpace && activeDocumentSpaceId && activeDocument ? (
            <CollectionScreen
              spacePath={activeSpace.path}
              projectPath={activeRootPath}
              documentPath={activeDocument}
              spaceId={activeDocumentSpaceId}
              hasReadme={activeNode.path.toLowerCase().endsWith(".md")}
            />
          ) : (
            <PlateDocumentEditor />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MainBreadcrumbs />
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize="65%">
          {isCollection && activeNode && activeSpace && activeDocumentSpaceId && activeDocument ? (
            <CollectionScreen
              spacePath={activeSpace.path}
              projectPath={activeRootPath}
              documentPath={activeDocument}
              spaceId={activeDocumentSpaceId}
              hasReadme={activeNode.path.toLowerCase().endsWith(".md")}
            />
          ) : (
            <PlateDocumentEditor />
          )}
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
  useKeyboardShortcuts();
  useAppGitFocus();
  const { spaces, activeRootId, activeRootPath, fileTrees } = useSpaceStore();
  const { available, recheck } = useGitAvailability();

  const hasChildren = spaces.length > 0;
  const rootTree = activeRootId ? fileTrees[activeRootId] ?? [] : [];
  const hasDocuments = rootTree.length > 0;
  const isEmpty = !hasChildren && !hasDocuments;

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
