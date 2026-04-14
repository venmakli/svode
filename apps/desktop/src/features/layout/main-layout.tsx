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
import { WorkspaceGitWatcher } from "@/features/workspace/workspace-git-watcher";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { EmptyProjectState } from "@/features/workspace/empty-project-state";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import { ChatPanel } from "@/features/chat/chat-panel";
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
import type { TreeNode } from "@/types/workspace";


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

function MainBreadcrumbs() {
  const { activeDocument, activeDocumentWorkspaceId } = useLayoutStore();
  const { spaces, activeSpaceId, fileTrees, openSpace } =
    useWorkspaceStore();
  const { openDocument } = useLayoutStore();

  if (!activeDocument) return null;

  const activeWorkspace = activeSpaceId
    ? spaces.find((w) => w.id === activeSpaceId)
    : null;
  const workspaceName = activeWorkspace
    ? `${activeWorkspace.icon} ${activeWorkspace.name}`
    : "";

  const treeId = activeDocumentWorkspaceId;
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
                  workspaces={spaces}
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
                  onClick={() => openDocument(seg.path)}
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
  try {
    return <WorkspaceBreadcrumbInner label={label} workspaces={workspaces} onSwitch={onSwitch} />;
  } catch {
    return <span>{label}</span>;
  }
}

function WorkspaceBreadcrumbInner({
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
  const { activeDocument, chatPanelOpen } = useLayoutStore();

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
          <PlateDocumentEditor />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MainBreadcrumbs />
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize="65%">
          <PlateDocumentEditor />
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
  const { spaces, activeRootId, activeRootPath, fileTrees } = useWorkspaceStore();
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
        {activeRootPath && <WorkspaceGitWatcher workspacePath={activeRootPath} />}
        <GitMissingDialog open={available === false} onRecheck={recheck} />
      </SidebarProvider>
    </TooltipProvider>
  );
}
