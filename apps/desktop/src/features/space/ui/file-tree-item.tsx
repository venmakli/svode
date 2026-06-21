import { useContext, type ReactElement } from "react";
import { useSortable } from "@dnd-kit/sortable";
import * as m from "@/paraglide/messages.js";
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronRight,
  Database,
  Ellipsis,
  FileText,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GripVertical,
  FileSymlink,
  Pencil,
  Trash2,
} from "lucide-react";
import type { TreeNode } from "@/features/entry";
import { FileGitIndicatorIcon } from "@/features/git/sidebar";
import { useFileTreeItemActions } from "../hooks/use-file-tree-item-actions";
import { TreeDndContext } from "./sortable-file-tree";
import { TreeDropIndicator } from "./tree-drop-indicator";
import { isDescendantOf } from "../lib/tree-dnd-utilities";

interface FileTreeItemProps {
  node: TreeNode;
  spaceId: string;
  loadTreeChildren: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
}

export function FileTreeItem({
  node,
  spaceId,
  loadTreeChildren,
}: FileTreeItemProps) {
  const {
    bareFolder,
    backlinkLabel,
    childLoading,
    closeDeleteDialog,
    deleteDialog,
    editRef,
    editValue,
    expandable,
    expanded,
    handleDeleteConfirm,
    handleDeleteRequest,
    handleDocumentClick,
    handleMakeCollection,
    handleMakeDocument,
    handleNewFolder,
    handleNewPage,
    handleNodeOpenChange,
    handleRenameKeyDown,
    handleRenameSubmit,
    handleStartRename,
    isActive,
    isEditing,
    isUnsaved,
    knownChildren,
    setEditValue,
    space,
  } = useFileTreeItemActions({ node, spaceId, loadTreeChildren });

  const { activeId, activeFolderPath, overId, projection, flatItemsMap } =
    useContext(TreeDndContext);

  // Disable sortable for children of the currently dragged folder
  const isChildOfDragged =
    !!activeFolderPath && isDescendantOf(node.path, activeFolderPath);

  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: node.path,
    disabled: isChildOfDragged,
  });
  const isOver = activeId !== null && overId === node.path;
  // Use projection.overPath as source of truth for nest highlight target
  const isProjectionTarget =
    activeId !== null && projection?.overPath === node.path;
  const myDepth = flatItemsMap.get(node.path)?.depth ?? 0;

  const style = {
    opacity: isDragging ? 0.4 : undefined,
  };

  const iconElement = node.icon ? (
    <span className="h-4 w-4 shrink-0 text-center leading-4">{node.icon}</span>
  ) : node.has_schema ? (
    <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : bareFolder ? (
    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="h-4 w-4 shrink-0" />
  );

  const dot = space ? (
    <span className="ml-auto shrink-0 flex items-center">
      <FileGitIndicatorIcon
        spacePath={space.path}
        filePath={node.path}
        pendingWrite={isUnsaved}
      />
    </span>
  ) : null;

  const titleElement = isEditing ? (
    <input
      ref={editRef}
      className="truncate bg-transparent outline-none text-sm w-full border-b border-primary"
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={handleRenameSubmit}
      onKeyDown={handleRenameKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <span className="truncate">{node.title}</span>
  );

  const hasDescription = !bareFolder && !!node.description?.trim();

  const dragHandle = (
    <button
      className="absolute -left-4 top-0 z-10 flex h-7 w-4 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100 cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-3 w-3" />
    </button>
  );

  const contextMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-7 w-5 shrink-0 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100">
          <Ellipsis className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        {bareFolder && !node.has_schema && (
          <DropdownMenuItem onClick={handleMakeDocument}>
            <FileSymlink className="mr-2 h-4 w-4" />
            {m.space_make_document()}
          </DropdownMenuItem>
        )}
        {!node.has_schema && (
          <DropdownMenuItem onClick={handleMakeCollection}>
            <Database className="mr-2 h-4 w-4" />
            {m.collection_make()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={handleNewPage}>
          <FilePlus className="mr-2 h-4 w-4" />
          {m.space_nest_page()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleNewFolder}>
          <FolderPlus className="mr-2 h-4 w-4" />
          {m.space_new_folder()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleStartRename}>
          <Pencil className="mr-2 h-4 w-4" />
          {m.space_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={handleDeleteRequest}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {m.space_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Relative depth: how much deeper/shallower the projected position is
  // compared to this item's actual depth
  const relativeDepth = projection ? projection.depth - myDepth : 0;
  const isNestTarget = isProjectionTarget && projection?.type === "child";
  const dropIndicator =
    isOver && projection && projection.type !== "child" ? (
      <TreeDropIndicator type={projection.type} relativeDepth={relativeDepth} />
    ) : null;

  const nestHighlight = isNestTarget
    ? "bg-sidebar-accent ring-1 ring-sidebar-primary/30 rounded-md"
    : "";

  const deleteConfirmDialog = (
    <AlertDialog
      open={deleteDialog.open}
      onOpenChange={(open) => {
        if (!open) closeDeleteDialog();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.file_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {node.has_schema
              ? m.file_delete_collection_description()
              : knownChildren
                ? m.file_delete_tree_description()
                : m.file_delete_description()}
            {deleteDialog.backlinks.length > 0 && (
              <>
                <br />
                <br />
                {m.file_delete_has_backlinks()}
                <ul className="mt-2 list-disc pl-5">
                  {deleteDialog.backlinks.map((bl) => (
                    <li
                      key={`${bl.sourceSpaceId ?? "root"}:${bl.sourcePath}`}
                      className="text-foreground"
                    >
                      {backlinkLabel(bl)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.file_delete_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={handleDeleteConfirm}
          >
            {m.file_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  function withDescriptionTooltip(element: ReactElement) {
    if (!hasDescription) return element;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{element}</TooltipTrigger>
        <TooltipContent
          side="right"
          className="flex flex-col items-start gap-0.5"
        >
          <span>{node.title}</span>
          <span className="text-xs text-muted-foreground">
            {node.description}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Leaf node (simple file without known children)
  if (!expandable) {
    return (
      <>
        <SidebarMenuSubItem ref={setNodeRef} style={style} className="relative">
          {dropIndicator}
          <div className="flex items-center group/tree-item">
            {dragHandle}
            {withDescriptionTooltip(
              <SidebarMenuSubButton
                isActive={isActive}
                className={`flex-1 ${nestHighlight}`}
                onClick={handleDocumentClick}
                onDoubleClick={handleStartRename}
              >
                {iconElement}
                {titleElement}
                {dot}
              </SidebarMenuSubButton>,
            )}
            {contextMenu}
          </div>
        </SidebarMenuSubItem>
        {deleteConfirmDialog}
      </>
    );
  }

  // Folder node (document with children, or bare folder)
  return (
    <>
      <SidebarMenuSubItem ref={setNodeRef} style={style} className="relative">
        {dropIndicator}
        <Collapsible
          open={expanded}
          onOpenChange={handleNodeOpenChange}
          className="group/collapsible"
        >
          <div className="flex items-center group/tree-item">
            {dragHandle}
            {withDescriptionTooltip(
              <SidebarMenuSubButton
                isActive={isActive}
                className={`flex-1 ${nestHighlight}`}
                onClick={handleDocumentClick}
                onDoubleClick={handleStartRename}
              >
                <CollapsibleTrigger
                  asChild
                  onClick={(e) => e.stopPropagation()}
                >
                  <button className="relative h-4 w-4 shrink-0 flex items-center justify-center">
                    <span className="group-hover/tree-item:opacity-0 transition-opacity">
                      {iconElement}
                    </span>
                    <ChevronRight className="absolute inset-0 m-auto h-3 w-3 opacity-0 group-hover/tree-item:opacity-100 transition-all group-data-[state=open]/collapsible:rotate-90" />
                  </button>
                </CollapsibleTrigger>
                {titleElement}
                {dot}
              </SidebarMenuSubButton>,
            )}
            {contextMenu}
          </div>
          <CollapsibleContent>
            <SidebarMenuSub className="border-l-0">
              {childLoading && node.children.length === 0 ? (
                <TreeChildLoadingRows />
              ) : (
                node.children.map((child) => (
                  <FileTreeItem
                    key={child.path}
                    node={child}
                    spaceId={spaceId}
                    loadTreeChildren={loadTreeChildren}
                  />
                ))
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
      </SidebarMenuSubItem>
      {deleteConfirmDialog}
    </>
  );
}

function TreeChildLoadingRows() {
  return (
    <>
      {[0, 1].map((index) => (
        <SidebarMenuSubItem key={index}>
          <div className="flex h-7 items-center gap-2 rounded-md px-2">
            <Skeleton className="size-4" />
            <Skeleton className={index === 0 ? "h-3 w-24" : "h-3 w-20"} />
          </div>
        </SidebarMenuSubItem>
      ))}
    </>
  );
}
