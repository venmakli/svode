import {
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  Database,
  Ellipsis,
  FilePlus,
  FolderDown,
  FolderPlus,
  Loader2,
  Pencil,
  Settings,
  Trash2,
  X,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TreeNode } from "@/features/entry";
import { cn } from "@/shared/lib/utils";
import type {
  ScopeTarget,
  DeleteSpaceTarget,
} from "../hooks/use-space-sidebar-actions";
import type { SpaceInfo } from "../model";
import { FileTreeItem } from "./file-tree-item";
import { TreeLoadingRows } from "./nav-space-indicators";
import { SortableFileTree } from "./sortable-file-tree";
import { useSpaceRowGitControls } from "./space-row-git-controls";

interface SpaceRowProps {
  ws: SpaceInfo;
  isActive: boolean;
  tree: TreeNode[];
  editingSpaceId: string | null;
  editValue: string;
  openOnActiveDocument: boolean;
  setEditValue: (v: string) => void;
  setEditingSpaceId: (id: string | null) => void;
  handleRenameSpace: () => void;
  handleNewPage: (scope: ScopeTarget) => void;
  handleNewFolder: (scope: ScopeTarget) => void;
  handleNewCollection: (scope: ScopeTarget) => void;
  openSpaceSettings: (path: string) => void;
  openScopeHome: (ws: SpaceInfo) => void;
  setDeleteTarget: (target: DeleteSpaceTarget) => void;
  handleCloneMissing: (spaceId: string, spacePath: string) => void;
  handleRemoveBroken: (spaceId: string) => void;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
  loadTreeChildren: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
  onActivateContent: () => void;
  editRef: RefObject<HTMLInputElement | null>;
  rootPath: string;
  loading: boolean;
  refreshing: boolean;
  treeLoaded: boolean;
}

export function SpaceRow({
  ws,
  isActive,
  tree,
  editingSpaceId,
  editValue,
  openOnActiveDocument,
  setEditValue,
  setEditingSpaceId,
  handleRenameSpace,
  handleNewPage,
  handleNewFolder,
  handleNewCollection,
  openSpaceSettings,
  openScopeHome,
  setDeleteTarget,
  handleCloneMissing,
  handleRemoveBroken,
  ensureTreeLoaded,
  loadTreeChildren,
  onActivateContent,
  editRef,
  rootPath,
  loading,
  refreshing,
  treeLoaded,
}: SpaceRowProps) {
  const gitControls = useSpaceRowGitControls({
    lfsState: ws.lfsState,
    loading,
    refreshing,
    rootPath,
    spacePath: ws.path,
  });
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ws.id });
  const sortableStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const sortableClassName = cn(isDragging && "opacity-60");
  const draggableRowClassName = cn(
    "cursor-pointer active:cursor-grabbing",
    isDragging && "cursor-grabbing",
  );
  const scope = { id: ws.id, path: ws.path };
  const [userOpen, setUserOpen] = useState(false);
  const open = userOpen || isActive || openOnActiveDocument;

  if (ws.status === "missing" || ws.status === "broken") {
    return (
      <SidebarMenuItem
        ref={setNodeRef}
        style={sortableStyle}
        className={sortableClassName}
        {...attributes}
        {...listeners}
      >
        <SidebarMenuButton disabled className="opacity-50">
          <span>{ws.icon || "\u{1F4C2}"}</span>
          <span className="flex-1 truncate text-muted-foreground">
            {ws.name}
          </span>
        </SidebarMenuButton>
        {gitControls.progress}
        {ws.status === "missing" && !gitControls.cloning && (
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuAction
                onClick={() => handleCloneMissing(ws.id, ws.path)}
              >
                <FolderDown />
              </SidebarMenuAction>
            </TooltipTrigger>
            <TooltipContent side="right">
              {m.space_clone_missing()}
            </TooltipContent>
          </Tooltip>
        )}
        {ws.status === "missing" && gitControls.cloning && (
          <SidebarMenuAction disabled>
            <Loader2 className="animate-spin" />
          </SidebarMenuAction>
        )}
        {ws.status === "broken" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuAction onClick={() => handleRemoveBroken(ws.id)}>
                <X />
              </SidebarMenuAction>
            </TooltipTrigger>
            <TooltipContent side="right">
              {m.space_remove_broken()}
            </TooltipContent>
          </Tooltip>
        )}
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(nextOpen) => {
        setUserOpen(nextOpen);
        if (nextOpen) void ensureTreeLoaded(ws.id);
      }}
    >
      <SidebarMenuItem
        ref={setNodeRef}
        style={sortableStyle}
        className={sortableClassName}
        {...attributes}
        {...listeners}
      >
        <SidebarMenuButton
          isActive={isActive}
          disabled={!!gitControls.cloning}
          className={draggableRowClassName}
          onClick={() => {
            if (editingSpaceId !== ws.id) openScopeHome(ws);
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
              className="w-full truncate border-b border-primary bg-transparent text-sm outline-none"
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
              onBlur={handleRenameSpace}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleRenameSpace();
                } else if (event.key === "Escape") setEditingSpaceId(null);
              }}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate">{ws.name}</span>
          )}
          {gitControls.inlineActivity}
        </SidebarMenuButton>
        {gitControls.progress}
        {gitControls.lfsActivity}
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
            <DropdownMenuItem onClick={() => handleNewPage(scope)}>
              <FilePlus />
              {m.space_new_page()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNewFolder(scope)}>
              <FolderPlus />
              {m.space_new_folder()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNewCollection(scope)}>
              <Database />
              {m.collection_new()}
            </DropdownMenuItem>
            {gitControls.dropdownItem}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openSpaceSettings(ws.path)}>
              <Settings />
              {m.space_settings()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setEditingSpaceId(ws.id);
                setEditValue(ws.name);
              }}
            >
              <Pencil />
              {m.space_rename()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setDeleteTarget({ id: ws.id, name: ws.name })}
            >
              <Trash2 />
              {m.space_delete()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          {loading && !treeLoaded ? (
            <TreeLoadingRows />
          ) : (
            <SortableFileTree spaceId={ws.id} tree={tree}>
              <SidebarMenuSub className="ml-4 border-l-0 pl-2">
                {tree.map((node) => (
                  <FileTreeItem
                    key={node.path}
                    node={node}
                    spaceId={ws.id}
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
