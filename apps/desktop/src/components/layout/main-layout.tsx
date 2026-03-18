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
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { EmptyProjectState } from "@/components/workspace/empty-project-state";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import { ChatPanel } from "@/features/chat/chat-panel";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";


function MainBreadcrumbs() {
  const { activeDocument } = useLayoutStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();

  if (!activeDocument) return null;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspaceName = activeWorkspace
    ? `${activeWorkspace.icon} ${activeWorkspace.name}`
    : "";

  // Show just the filename without .md extension
  const fileName = activeDocument.split("/").pop()?.replace(/\.md$/, "") ?? activeDocument;

  return (
    <div className="border-b px-4 py-1.5">
      <Breadcrumb>
        <BreadcrumbList>
          {workspaceName && (
            <>
              <BreadcrumbItem className="text-sm">
                {workspaceName}
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </>
          )}
          <BreadcrumbItem className="text-sm">{fileName}</BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}

function MainContent() {
  const { activeDocument, chatPanelOpen } = useLayoutStore();

  // Mode A: no document open -> fullscreen chat
  if (!activeDocument) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <MainBreadcrumbs />
        <div className="flex-1 min-h-0">
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
          <ChatPanel />
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
      <SidebarProvider>
        <WindowHeader />
        <AppSidebar />
        <SidebarInset className="pt-[44px]">
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
