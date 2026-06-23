import {
  ChevronRight,
  Database,
  Ellipsis,
  FilePlus,
  FolderPlus,
  Plus,
  Settings,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import type { TreeNode } from "../model/types";
import { SpaceGitActivityIndicator } from "@/features/git/sidebar";
import { FileTreeItem } from "./file-tree-item";
import { SortableFileTree } from "./sortable-file-tree";
import { TreeLoadingRows } from "./nav-space-indicators";

interface RootScopeRowProps {
  active: boolean;
  icon: string | null;
  name: string | null;
  open: boolean;
  tree: TreeNode[];
  onOpenChange: (open: boolean) => void;
  onOpenHome: () => void;
  onNewPage: () => void;
  onNewFolder: () => void;
  onNewCollection: () => void;
  onAddSpace: () => void;
  onProjectSettings: () => void;
  spaceId: string;
  rootPath: string;
  loading: boolean;
  refreshing: boolean;
  treeLoaded: boolean;
  loadTreeChildren: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
  onActivateContent: () => void;
}

export function RootScopeRow({
  active,
  icon,
  name,
  open,
  tree,
  onOpenChange,
  onOpenHome,
  onNewPage,
  onNewFolder,
  onNewCollection,
  onAddSpace,
  onProjectSettings,
  spaceId,
  rootPath,
  loading,
  refreshing,
  treeLoaded,
  loadTreeChildren,
  onActivateContent,
}: RootScopeRowProps) {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={active} onClick={onOpenHome}>
          <span>{icon || "\u{1F4C1}"}</span>
          <span className="flex-1 truncate">{name || "Project"}</span>
          <span className="ml-auto flex items-center gap-1">
            <SpaceGitActivityIndicator
              spacePath={rootPath}
              loading={loading || refreshing}
            />
          </span>
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
            <DropdownMenuItem onClick={onNewPage}>
              <FilePlus />
              {m.space_new_page()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onNewFolder}>
              <FolderPlus />
              {m.space_new_folder()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onNewCollection}>
              <Database />
              {m.collection_new()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onAddSpace}>
              <Plus />
              {m.sidebar_add_space()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onProjectSettings}>
              <Settings />
              {m.sidebar_project_settings()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          {loading && !treeLoaded ? (
            <TreeLoadingRows />
          ) : (
            <SortableFileTree spaceId={spaceId} tree={tree}>
              <SidebarMenuSub className="ml-4 border-l-0 pl-2">
                {tree.map((node) => (
                  <FileTreeItem
                    key={node.path}
                    node={node}
                    spaceId={spaceId}
                    loadTreeChildren={loadTreeChildren}
                    onActivateContent={onActivateContent}
                  />
                ))}
              </SidebarMenuSub>
            </SortableFileTree>
          )}
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
