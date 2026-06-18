import { invokeCommand as invoke } from "@/platform/native/invoke";
import * as m from "@/paraglide/messages.js";
import { toast } from "sonner";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Database, FilePlus, FolderPlus, Plus } from "lucide-react";
import { useSpaceStore } from "../model";
import { useEntrySelectionStore } from "@/features/entry";
import { SortableFileTree } from "./sortable-file-tree";
import { FileTreeItem } from "./file-tree-item";
import { createCollection } from "@/features/collection";

export function NavDocuments() {
  const {
    activeRootId,
    activeRootPath,
    fileTrees,
    createEntry,
    reloadTreeParent,
    loadTreeChildren,
  } = useSpaceStore();
  const { openDocument } = useEntrySelectionStore();

  if (!activeRootId || !activeRootPath) return null;

  const tree = fileTrees[activeRootId] ?? [];

  async function handleNewPage() {
    if (!activeRootPath) return;
    try {
      const entry = await createEntry(activeRootPath, "Untitled");
      if (entry && activeRootId) {
        openDocument(entry.path, activeRootId);
      }
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewFolder() {
    if (!activeRootId || !activeRootPath) return;
    try {
      await invoke<string>("create_folder", {
        space: activeRootPath,
        parentPath: null,
        name: m.space_new_folder(),
        projectPath: activeRootPath,
      });
      await reloadTreeParent(activeRootId, null);
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewCollection() {
    if (!activeRootId || !activeRootPath) return;
    try {
      const entry = await createCollection({
        spacePath: activeRootPath,
        title: m.editor_untitled(),
        projectPath: activeRootPath,
      });
      await reloadTreeParent(activeRootId, null);
      openDocument(entry.path, activeRootId);
    } catch (err) {
      console.error("Failed to create collection:", err);
      toast.error(m.toast_error());
    }
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{m.sidebar_documents()}</SidebarGroupLabel>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarGroupAction>
            <Plus />
          </SidebarGroupAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuItem onClick={handleNewPage}>
            <FilePlus className="mr-2 h-4 w-4" />
            {m.space_new_page()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleNewFolder}>
            <FolderPlus className="mr-2 h-4 w-4" />
            {m.space_new_folder()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleNewCollection}>
            <Database className="mr-2 h-4 w-4" />
            {m.collection_new()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidebarGroupContent>
        <SidebarMenu>
          <SortableFileTree spaceId={activeRootId} tree={tree}>
            <SidebarMenuSub>
              {tree.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  spaceId={activeRootId}
                  loadTreeChildren={loadTreeChildren}
                />
              ))}
            </SidebarMenuSub>
          </SortableFileTree>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
