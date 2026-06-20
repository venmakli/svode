import * as m from "@/paraglide/messages.js";
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
import { useRootDocumentActions } from "../hooks/use-root-document-actions";
import { SortableFileTree } from "./sortable-file-tree";
import { FileTreeItem } from "./file-tree-item";

export function NavDocuments() {
  const {
    activeRootId,
    activeRootPath,
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
    loadTreeChildren,
    tree,
  } = useRootDocumentActions();

  if (!activeRootId || !activeRootPath) return null;

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
