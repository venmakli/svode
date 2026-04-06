import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as m from "@/paraglide/messages.js";
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
  FolderPlus,
  Plus,
  Settings,
  Pencil,
  Trash2,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import type { WorkspaceConfig } from "@/types/workspace";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { SortableFileTree } from "./sortable-file-tree";
import { FileTreeItem } from "./file-tree-item";

export function NavWorkspaces() {
  const {
    children,
    activeChildId,
    activeRootPath,
    fileTrees,
    openChild,
    deleteChild,
    createPage,
    refreshTree,
  } = useWorkspaceStore();
  const { openDocument, openWorkspaceSettings } = useLayoutStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingWorkspaceId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingWorkspaceId]);

  async function handleRenameWorkspace() {
    const ws = children.find((w) => w.id === editingWorkspaceId);
    if (!ws || !editValue.trim() || editValue.trim() === ws.name) {
      setEditingWorkspaceId(null);
      return;
    }
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", {
        workspacePath: ws.path,
      });
      await invoke("save_workspace_config", {
        workspacePath: ws.path,
        configData: { ...cfg, name: editValue.trim() },
      });
      useWorkspaceStore.setState({
        children: useWorkspaceStore.getState().children.map((w) =>
          w.id === editingWorkspaceId ? { ...w, name: editValue.trim() } : w
        ),
      });
    } catch (err) {
      console.error("Failed to rename workspace:", err);
      toast.error(m.toast_error());
    }
    setEditingWorkspaceId(null);
  }

  async function handleNewPage(ws: { id: string; path: string }) {
    try {
      const entry = await createPage(ws.path, "Untitled");
      if (entry) {
        openDocument(entry.path, ws.id);
      }
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewFolder(ws: { id: string; path: string }) {
    try {
      await invoke<string>("create_folder", {
        workspace: ws.path,
        parentPath: null,
        name: m.workspace_new_folder(),
      });
      await refreshTree(ws.id);
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDeleteWorkspace(childId: string) {
    if (!activeRootPath) return;
    try {
      await deleteChild(activeRootPath, childId, deleteFiles);
    } catch (err) {
      console.error("Failed to delete workspace:", err);
      toast.error(m.toast_error());
    }
    setDeleteTarget(null);
    setDeleteFiles(false);
  }

  // Only show children section if there are children
  if (children.length === 0 && !activeRootPath) return null;

  return (
    <>
      {children.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>{m.sidebar_workspaces()}</SidebarGroupLabel>
          <SidebarGroupAction
            title={m.workspace_create()}
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus />
            <span className="sr-only">{m.workspace_create()}</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {children.map((ws) => {
                const tree = fileTrees[ws.id] ?? [];
                const isActive = ws.id === activeChildId;

                return (
                  <Collapsible
                    key={ws.id}
                    defaultOpen={isActive}
                  >
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => { if (editingWorkspaceId !== ws.id) openChild(ws.id); }}
                        onDoubleClick={() => {
                          setEditingWorkspaceId(ws.id);
                          setEditValue(ws.name);
                        }}
                      >
                        <span>{ws.icon}</span>
                        {editingWorkspaceId === ws.id ? (
                          <input
                            ref={editRef}
                            className="truncate bg-transparent outline-none text-sm w-full border-b border-primary"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleRenameWorkspace}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); handleRenameWorkspace(); }
                              else if (e.key === "Escape") setEditingWorkspaceId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span>{ws.name}</span>
                        )}
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
                          <DropdownMenuItem onClick={() => handleNewPage(ws)}>
                            <FilePlus className="mr-2 h-4 w-4" />
                            {m.workspace_new_page()}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleNewFolder(ws)}>
                            <FolderPlus className="mr-2 h-4 w-4" />
                            {m.workspace_new_folder()}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openWorkspaceSettings(ws.path)}>
                            <Settings className="mr-2 h-4 w-4" />
                            {m.workspace_settings()}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            setEditingWorkspaceId(ws.id);
                            setEditValue(ws.name);
                          }}>
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
      )}

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
