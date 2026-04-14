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
  Save,
  Settings,
  Pencil,
  Trash2,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import type { TreeNode, WorkspaceConfig } from "@/types/workspace";
import { CreateSpaceDialog } from "./create-space-dialog";
import { SortableFileTree } from "./sortable-file-tree";
import { FileTreeItem } from "./file-tree-item";
import { WorkspaceGitIndicatorIcon } from "./git-status-indicator";
import { WorkspaceGitWatcher } from "./workspace-git-watcher";
import { useGitStore } from "@/stores/git";
import { Progress } from "@/components/ui/progress";
import { commitAllWorkspace } from "./git-actions";

export function NavSpaces() {
  const {
    spaces,
    activeSpaceId,
    activeRootPath,
    fileTrees,
    openSpace,
    deleteSpace,
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
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSpaceId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingSpaceId]);

  async function handleRenameSpace() {
    const ws = spaces.find((w) => w.id === editingSpaceId);
    if (!ws || !editValue.trim() || editValue.trim() === ws.name) {
      setEditingSpaceId(null);
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
        spaces: useWorkspaceStore.getState().spaces.map((w) =>
          w.id === editingSpaceId ? { ...w, name: editValue.trim() } : w
        ),
      });
    } catch (err) {
      console.error("Failed to rename space:", err);
      toast.error(m.toast_error());
    }
    setEditingSpaceId(null);
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
        name: m.space_new_folder(),
      });
      await refreshTree(ws.id);
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDeleteSpace(spaceId: string) {
    if (!activeRootPath) return;
    try {
      await deleteSpace(activeRootPath, spaceId, deleteFiles);
    } catch (err) {
      console.error("Failed to delete space:", err);
      toast.error(m.toast_error());
    }
    setDeleteTarget(null);
    setDeleteFiles(false);
  }

  // Only show spaces section if there are spaces
  if (spaces.length === 0 && !activeRootPath) return null;

  return (
    <>
      {spaces.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>{m.sidebar_spaces()}</SidebarGroupLabel>
          <SidebarGroupAction
            title={m.space_create()}
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus />
            <span className="sr-only">{m.space_create()}</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {spaces.map((ws) => {
                const tree = fileTrees[ws.id] ?? [];
                const isActive = ws.id === activeSpaceId;
                return (
                  <SpaceRow
                    key={ws.id}
                    ws={ws}
                    isActive={isActive}
                    tree={tree}
                    editingSpaceId={editingSpaceId}
                    editValue={editValue}
                    setEditValue={setEditValue}
                    setEditingSpaceId={setEditingSpaceId}
                    handleRenameSpace={handleRenameSpace}
                    handleNewPage={handleNewPage}
                    handleNewFolder={handleNewFolder}
                    openWorkspaceSettings={openWorkspaceSettings}
                    openSpace={openSpace}
                    setDeleteTarget={setDeleteTarget}
                    editRef={editRef}
                  />
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      <CreateSpaceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteFiles(false); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.space_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.space_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 py-2 cursor-pointer">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <span className="text-sm text-destructive">
              {m.space_delete_files()}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                deleteTarget && handleDeleteSpace(deleteTarget.id)
              }
            >
              {m.space_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface SpaceRowProps {
  ws: { id: string; name: string; icon: string; path: string };
  isActive: boolean;
  tree: TreeNode[];
  editingSpaceId: string | null;
  editValue: string;
  setEditValue: (v: string) => void;
  setEditingSpaceId: (id: string | null) => void;
  handleRenameSpace: () => void;
  handleNewPage: (ws: { id: string; path: string }) => void;
  handleNewFolder: (ws: { id: string; path: string }) => void;
  openWorkspaceSettings: (path: string) => void;
  openSpace: (id: string) => void;
  setDeleteTarget: (t: { id: string; name: string }) => void;
  editRef: React.RefObject<HTMLInputElement | null>;
}

function SpaceRow({
  ws,
  isActive,
  tree,
  editingSpaceId,
  editValue,
  setEditValue,
  setEditingSpaceId,
  handleRenameSpace,
  handleNewPage,
  handleNewFolder,
  openWorkspaceSettings,
  openSpace,
  setDeleteTarget,
  editRef,
}: SpaceRowProps) {
  const cloning = useGitStore((s) => s.cloning[ws.path]);
  const dirty = useGitStore(
    (s) =>
      !!(s.statuses[ws.path]?.hasStaged || s.statuses[ws.path]?.hasUnstaged),
  );

  return (
    <Collapsible defaultOpen={isActive}>
      <WorkspaceGitWatcher workspacePath={ws.path} />
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          disabled={!!cloning}
          onClick={() => {
            if (editingSpaceId !== ws.id) openSpace(ws.id);
          }}
          onDoubleClick={() => {
            setEditingSpaceId(ws.id);
            setEditValue(ws.name);
          }}
        >
          <span>{ws.icon}</span>
          {editingSpaceId === ws.id ? (
            <input
              ref={editRef}
              className="truncate bg-transparent outline-none text-sm w-full border-b border-primary"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRenameSpace}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleRenameSpace();
                } else if (e.key === "Escape") setEditingSpaceId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate">{ws.name}</span>
          )}
          <span className="ml-auto flex items-center">
            <WorkspaceGitIndicatorIcon workspacePath={ws.path} />
          </span>
        </SidebarMenuButton>
        {cloning && (
          <div className="px-2 pb-1">
            <Progress value={cloning.percent} className="h-1" />
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
              {cloning.error ? cloning.error : `${cloning.phase} ${cloning.percent}%`}
            </p>
          </div>
        )}
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
              {m.space_new_page()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNewFolder(ws)}>
              <FolderPlus className="mr-2 h-4 w-4" />
              {m.space_new_folder()}
            </DropdownMenuItem>
            {dirty && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => commitAllWorkspace(ws.path)}>
                  <Save className="mr-2 h-4 w-4" />
                  {m.git_save_all()}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openWorkspaceSettings(ws.path)}>
              <Settings className="mr-2 h-4 w-4" />
              {m.space_settings()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setEditingSpaceId(ws.id);
                setEditValue(ws.name);
              }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              {m.space_rename()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setDeleteTarget({ id: ws.id, name: ws.name })}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {m.space_delete()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          <SortableFileTree workspaceId={ws.id} tree={tree}>
            <SidebarMenuSub>
              {tree.map((node) => (
                <FileTreeItem key={node.path} node={node} workspaceId={ws.id} />
              ))}
            </SidebarMenuSub>
          </SortableFileTree>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
