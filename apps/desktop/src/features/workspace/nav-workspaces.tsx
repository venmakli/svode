import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronRight,
  Ellipsis,
  FilePlus,
  FolderOpen,
  Plus,
  Settings,
  Pencil,
  Trash2,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { FileTreeItem } from "./file-tree-item";
import { SortableFileTree } from "./sortable-file-tree";

export function NavWorkspaces() {
  const {
    workspaces,
    activeWorkspaceId,
    activeProjectId,
    fileTrees,
    openWorkspace,
    openFolderAsWorkspace,
    deleteWorkspace,
    createPage,
  } = useWorkspaceStore();
  const { openDocument, openWorkspaceSettings } = useLayoutStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);

  async function handleOpenFolder() {
    if (!activeProjectId) return;
    const selected = await open({ directory: true });
    if (selected) {
      try {
        await openFolderAsWorkspace(activeProjectId, selected);
      } catch (err) {
        console.error("Failed to open folder as workspace:", err);
        toast.error(m.toast_error());
      }
    }
  }

  async function handleNewPage(workspaceId: string) {
    try {
      const entry = await createPage(workspaceId, "Untitled");
      if (entry) {
        openDocument(entry.path);
      }
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDeleteWorkspace(workspaceId: string) {
    if (!activeProjectId) return;
    try {
      await deleteWorkspace(activeProjectId, workspaceId, deleteFiles);
      toast.success(m.toast_workspace_deleted());
    } catch (err) {
      console.error("Failed to delete workspace:", err);
      toast.error(m.toast_error());
    }
    setDeleteTarget(null);
    setDeleteFiles(false);
  }

  function handleWorkspaceClick(ws: { id: string; exists: boolean; path: string }) {
    if (!ws.exists) {
      toast.error(m.workspace_not_found({ path: ws.path }), {
        action: {
          label: m.workspace_not_found_action_remove(),
          onClick: () => {
            if (activeProjectId) {
              deleteWorkspace(activeProjectId, ws.id);
            }
          },
        },
      });
      return;
    }
    openWorkspace(ws.id);
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
                      onClick={() => handleWorkspaceClick(ws)}
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover>
                          <Ellipsis />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" side="bottom">
                        <DropdownMenuItem onClick={() => handleNewPage(ws.id)}>
                          <FilePlus className="mr-2 h-4 w-4" />
                          {m.workspace_new_page()}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => openWorkspaceSettings(ws.id)}>
                          <Settings className="mr-2 h-4 w-4" />
                          {m.workspace_settings()}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled>
                          <Pencil className="mr-2 h-4 w-4" />
                          {m.workspace_rename()}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() =>
                            setDeleteTarget({ id: ws.id, name: ws.name })
                          }
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {m.workspace_delete()}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <CollapsibleContent>
                      <SortableFileTree
                        workspaceId={ws.id}
                        tree={tree}
                      >
                        <SidebarMenuSub>
                          {tree.map((node) => (
                            <FileTreeItem
                              key={node.path}
                              node={node}
                              workspaceId={ws.id}
                            />
                          ))}
                        </SidebarMenuSub>
                      </SortableFileTree>
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

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteFiles(false); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.workspace_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.workspace_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 py-2 cursor-pointer">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <span className="text-sm text-destructive">
              {m.workspace_delete_files()}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                deleteTarget && handleDeleteWorkspace(deleteTarget.id)
              }
            >
              {m.workspace_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
