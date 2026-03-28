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
    // Check if this folder's path (without /readme.md) matches a segment
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

  // Build cumulative paths for each directory segment
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const cumPath = parts.slice(0, i + 1).join("/");

    // Skip readme.md as last segment — the folder title already represents it
    if (i === parts.length - 1 && part.toLowerCase() === "readme.md") continue;

    // For directory segments, look up title
    if (i < parts.length - 1) {
      const title = findTitleInTree(tree, cumPath) ?? part;
      segments.push({ label: title, path: cumPath + "/readme.md" });
    } else {
      // File segment
      const title =
        findTitleInTree(tree, cumPath) ?? part.replace(/\.md$/, "");
      segments.push({ label: title, path: cumPath });
    }
  }

  return segments;
}

function MainBreadcrumbs() {
  const { activeDocument } = useLayoutStore();
  const { workspaces, activeWorkspaceId, fileTrees, openWorkspace } =
    useWorkspaceStore();
  const { openDocument } = useLayoutStore();

  if (!activeDocument) return null;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspaceName = activeWorkspace
    ? `${activeWorkspace.icon} ${activeWorkspace.name}`
    : "";

  const tree = activeWorkspaceId ? fileTrees[activeWorkspaceId] ?? [] : [];
  const segments = buildSegments(activeDocument, tree);

  // For deep paths, show first + last 2, with ellipsis in between
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
                  workspaces={workspaces}
                  onSwitch={openWorkspace}
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

/** Workspace breadcrumb item — shows dropdown when sidebar is collapsed. */
function WorkspaceBreadcrumb({
  label,
  workspaces,
  onSwitch,
}: {
  label: string;
  workspaces: { id: string; name: string; icon: string }[];
  onSwitch: (id: string) => void;
}) {
  // Try to use sidebar context — if not available, just render label
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

  // Mode A: no document open -> fullscreen chat
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

  // Mode B: document only (chat hidden)
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

  // Mode B: document + chat panel
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
  const { workspaces, activeProjectId } = useWorkspaceStore();

  const hasWorkspaces = workspaces.length > 0;

  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider className="min-h-0 h-dvh overflow-hidden">
        <WindowHeader />
        <AppSidebar />
        <SidebarInset className="pt-[44px] min-h-0 overflow-hidden">
          {activeProjectId && !hasWorkspaces ? (
            <EmptyProjectState />
          ) : (
            <MainContent />
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
