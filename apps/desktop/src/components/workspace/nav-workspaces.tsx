import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, FolderOpen, Plus } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { FileTreeItem } from "./file-tree-item";

export function NavWorkspaces() {
  const {
    workspaces,
    activeWorkspaceId,
    activeProjectId,
    fileTrees,
    openWorkspace,
    openFolderAsWorkspace,
  } = useWorkspaceStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  async function handleOpenFolder() {
    if (!activeProjectId) return;
    const selected = await open({ directory: true });
    if (selected) {
      try {
        await openFolderAsWorkspace(activeProjectId, selected);
      } catch (err) {
        console.error("Failed to open folder as workspace:", err);
      }
    }
  }

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{m.sidebar_workspaces()}</SidebarGroupLabel>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarGroupAction title={m.workspace_create()}>
              <Plus />
              <span className="sr-only">{m.workspace_create()}</span>
            </SidebarGroupAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {m.workspace_create()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenFolder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {m.workspace_open_folder()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SidebarGroupContent>
          <SidebarMenu>
            {workspaces.map((ws) => {
              const tree = fileTrees[ws.id] ?? [];
              const isActive = ws.id === activeWorkspaceId;

              return (
                <Collapsible
                  key={ws.id}
                  defaultOpen={isActive}
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => openWorkspace(ws.id)}
                    >
                      <span>{ws.icon}</span>
                      <span>{ws.name}</span>
                    </SidebarMenuButton>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction
                        className="left-2 bg-sidebar-accent text-sidebar-accent-foreground data-[state=open]:rotate-90"
                        showOnHover
                      >
                        <ChevronRight />
                      </SidebarMenuAction>
                    </CollapsibleTrigger>
                    <SidebarMenuAction showOnHover>
                      <Plus />
                    </SidebarMenuAction>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {tree.map((node) => (
                          <FileTreeItem key={node.path} node={node} />
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <CreateWorkspaceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </>
  );
}
