import { ChevronRight, Ellipsis } from "lucide-react";
import {
  ContentActionMenuItems,
  contentActionGroups,
} from "@/features/content-actions";
import { spaceNavigationKey } from "@/features/navigation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
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
  onOpenHome: () => void | Promise<void>;
  onNewPage: () => void;
  onNewFolder: () => void;
  onNewCollection: () => void;
  onNewSession?: () => void;
  onNewTerminal?: () => void;
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
  onBeforeNavigation: () => Promise<boolean>;
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
  onNewSession,
  onNewTerminal,
  spaceId,
  rootPath,
  loading,
  refreshing,
  treeLoaded,
  loadTreeChildren,
  onActivateContent,
  onBeforeNavigation,
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
            <ContentActionMenuItems
              groups={contentActionGroups({
                object: { kind: "project-root" },
                surfaceActions: {
                  newSession: Boolean(onNewSession),
                  newTerminal: Boolean(onNewTerminal),
                },
              })}
              pinItem={{
                key: spaceNavigationKey(null, null),
                title: name ?? "",
                ...(icon ? { icon } : {}),
              }}
              handlers={{
                "new-page": onNewPage,
                "new-folder": onNewFolder,
                "new-collection": onNewCollection,
                "new-session": onNewSession,
                "new-terminal": onNewTerminal,
              }}
            />
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
                    onBeforeNavigation={onBeforeNavigation}
                    projectPath={rootPath}
                    spacePath={rootPath}
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
