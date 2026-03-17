import * as m from "@/paraglide/messages.js";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

function ChatPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <p className="text-lg font-medium">{m.chat_title()}</p>
      <p className="text-sm">{m.chat_placeholder()}</p>
    </div>
  );
}

function DocumentPlaceholder() {
  const { activeDocument } = useLayoutStore();
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <p className="text-lg font-medium">{m.editor_title()}</p>
      <p className="text-sm">{activeDocument}</p>
      <p className="text-xs mt-2">{m.editor_placeholder()}</p>
    </div>
  );
}

function MainBreadcrumbs() {
  const { activeDocument } = useLayoutStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();

  if (!activeDocument) return null;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspaceName = activeWorkspace
    ? `${activeWorkspace.icon} ${activeWorkspace.name}`
    : "";

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
          <BreadcrumbItem className="text-sm">{activeDocument}</BreadcrumbItem>
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
      <div className="flex h-full flex-col">
        <MainBreadcrumbs />
        <div className="flex-1">
          <ChatPlaceholder />
        </div>
      </div>
    );
  }

  // Mode B: document only (chat hidden)
  if (!chatPanelOpen) {
    return (
      <div className="flex h-full flex-col">
        <MainBreadcrumbs />
        <div className="flex-1">
          <DocumentPlaceholder />
        </div>
      </div>
    );
  }

  // Mode B: document + chat panel
  return (
    <div className="flex h-full flex-col">
      <MainBreadcrumbs />
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={65} minSize={30}>
          <DocumentPlaceholder />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={35} minSize={20} maxSize={45}>
          <ChatPlaceholder />
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
