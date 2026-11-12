import {
  memo,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type ReactElement,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import * as m from "@/paraglide/messages.js";
import {
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldError } from "@/components/ui/field";
import {
  ChevronRight,
  Database,
  Ellipsis,
  FileText,
  FolderOpen,
  GripVertical,
  PanelsTopLeft,
} from "lucide-react";
import type { TreeNode } from "../model/types";
import { getDirectoryPresentationKind } from "@/features/artifact";
import {
  ContentDeleteDialog,
  useContentMenuHandlers,
} from "@/features/content-actions";
import { FileGitIndicatorIcon } from "@/features/git/sidebar";
import { cn } from "@/shared/lib/utils";
import { useFileTreeItemActions } from "../hooks/use-file-tree-item-actions";
import { treeNodeHasChildren } from "../lib/tree-cache";
import { treeRowInset } from "../lib/file-tree-rows";
import { FileTreeItemMenuItems } from "./file-tree-item-menu";
import { TreeDropIndicator } from "./tree-drop-indicator";
import { writeSvodeResourceDragData } from "../lib/resource-drag";
import type { SvodeDraggedResourceKind } from "../model/resource-drag";

type LoadTreeChildren = (
  spaceId: string,
  parentPath?: string | null,
) => Promise<void>;

interface FileTreeItemProps {
  node: TreeNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  isActive: boolean;
  /** Index of the row in the virtual list, read by its measurement. */
  index: number;
  /** Vertical place of the row inside the list. */
  offset: number;
  measureRef: (element: HTMLLIElement | null) => void;
  /** Keeps the row mounted while it holds a rename, menu, dialog or focus. */
  onKeepMountedChange: (path: string, keepMounted: boolean) => void;
  sortableDisabled: boolean;
  dropType: "before" | "after" | null;
  dropRelativeDepth: number;
  nestTarget: boolean;
  spaceId: string;
  loadTreeChildren: LoadTreeChildren;
  onActivateContent?: () => void;
  onBeforeNavigation?: () => Promise<boolean>;
  projectPath: string;
  spacePath: string;
}

/** A row's place in the root list of the flat tree. */
function treeRowStyle(depth: number, offset: number): CSSProperties {
  const { left, right } = treeRowInset(depth);
  return {
    position: "absolute",
    top: 0,
    left,
    right,
    transform: `translateY(${offset}px)`,
  };
}

function FileTreeItemRow({
  node,
  depth,
  expandable,
  expanded,
  isActive,
  index,
  offset,
  measureRef,
  onKeepMountedChange,
  sortableDisabled,
  dropType,
  dropRelativeDepth,
  nestTarget,
  spaceId,
  loadTreeChildren,
  onActivateContent,
  onBeforeNavigation,
  projectPath,
  spacePath,
}: FileTreeItemProps) {
  const {
    bareFolder,
    cancelDelete,
    deleteConfirmation,
    editRef,
    editValue,
    handleDeleteConfirm,
    handleDeleteRequest,
    handleDuplicate,
    handlePageClick,
    handleMakeCollection,
    handleMakeLeaf,
    handleMakePage,
    pinItem,
    handleNewFolder,
    handleNewPage,
    handleNodeOpenChange,
    handleRenameKeyDown,
    handleRenameSubmit,
    handleStartRename,
    isEditing,
    renameConflictPath,
    isUnsaved,
    knownChildren,
    setEditValue,
    space,
  } = useFileTreeItemActions({
    node,
    spaceId,
    expanded,
    loadTreeChildren,
    onActivateContent,
    onBeforeNavigation,
  });

  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: node.path,
    disabled: sortableDisabled,
  });
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      setNodeRef(element);
    },
    [setNodeRef],
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const keepMounted =
    isEditing || menuOpen || deleteConfirmation !== null || focused;
  useEffect(() => {
    if (!keepMounted) return;
    onKeepMountedChange(node.path, true);
    return () => onKeepMountedChange(node.path, false);
  }, [keepMounted, node.path, onKeepMountedChange]);
  const handleFocus = () => setFocused(true);
  const handleBlur = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocused(false);
    }
  };

  const style: CSSProperties = {
    ...treeRowStyle(depth, offset),
    opacity: isDragging ? 0.4 : undefined,
  };

  const presentationKind = getDirectoryPresentationKind({
    hasSchema: node.has_schema,
    hasApp: node.has_app ?? false,
    hasPage: !bareFolder,
  });
  const iconElement = node.icon ? (
    <span className="h-4 w-4 shrink-0 text-center leading-4">{node.icon}</span>
  ) : presentationKind === "collection" ? (
    <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : presentationKind === "app" ? (
    <PanelsTopLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : presentationKind === "directory" ? (
    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="h-4 w-4 shrink-0" />
  );

  const dot = space ? (
    <span className="ml-auto shrink-0 flex items-center">
      <FileGitIndicatorIcon
        spacePath={space.path}
        filePath={node.path}
        isContainer={
          bareFolder || knownChildren || node.has_schema || node.has_app
        }
        pendingWrite={isUnsaved}
      />
    </span>
  ) : null;

  const resourceKind: SvodeDraggedResourceKind = node.has_schema
    ? "collection"
    : bareFolder
      ? "folder"
      : "file";
  const handleResourceDragStart = (event: DragEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    writeSvodeResourceDragData(event.dataTransfer, {
      version: 1,
      kind: resourceKind,
      projectPath,
      spacePath,
      relativePath: node.path,
      title: node.title,
    });
  };
  const projectedConflictPath = node.name_conflict?.conflicts[0]?.path ?? null;
  const renameErrorId = `tree-name-error-${node.path.replace(/[^a-z0-9_-]/gi, "-")}`;
  const titleElement = isEditing ? (
    <div className="flex min-w-0 flex-1 flex-col">
      <input
        ref={editRef}
        className="w-full truncate border-b border-primary bg-transparent text-sm outline-none"
        value={editValue}
        aria-invalid={renameConflictPath ? true : undefined}
        aria-describedby={renameConflictPath ? renameErrorId : undefined}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleRenameSubmit}
        onKeyDown={(event) => {
          handleRenameKeyDown(event);
          // Escape removes the focused field without a blur event.
          if (event.key === "Escape") setFocused(false);
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <FieldError id={renameErrorId} className="truncate text-[10px] leading-3">
        {renameConflictPath
          ? m.page_name_conflict({ path: renameConflictPath })
          : null}
      </FieldError>
    </div>
  ) : (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{node.title}</span>
      {projectedConflictPath ? (
        <span className="truncate text-[10px] leading-3 text-muted-foreground">
          {node.path}
        </span>
      ) : null}
    </div>
  );

  const hasDescription =
    (!bareFolder || node.has_app) && !!node.description?.trim();
  const hasMetadataTooltip = hasDescription || !!projectedConflictPath;

  const dragHandle = (
    <button
      className="absolute -left-4 top-0 z-10 flex h-7 w-4 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100 cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-3 w-3" />
    </button>
  );

  const menu = useContentMenuHandlers({
    "nest-page": () => void handleNewPage(),
    "new-item": () => void handleNewPage(),
    "new-folder": () => void handleNewFolder(),
    "make-page": () => void handleMakePage(),
    "make-collection": () => void handleMakeCollection(),
    "make-leaf": () => void handleMakeLeaf(),
    rename: handleStartRename,
    duplicate: () => void handleDuplicate(),
    delete: () => void handleDeleteRequest(),
  });

  const contextMenu = (
    <DropdownMenu onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex h-7 w-5 shrink-0 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100">
          <Ellipsis className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        onCloseAutoFocus={menu.onCloseAutoFocus}
      >
        <FileTreeItemMenuItems
          node={node}
          spacePath={spacePath}
          pinItem={pinItem}
          handlers={menu.handlers}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const dropIndicator = dropType ? (
    <TreeDropIndicator type={dropType} relativeDepth={dropRelativeDepth} />
  ) : null;

  const nestHighlight = nestTarget
    ? "bg-sidebar-accent ring-1 ring-sidebar-primary/30 rounded-md"
    : "";

  function withDescriptionTooltip(element: ReactElement) {
    if (!hasMetadataTooltip) return element;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{element}</TooltipTrigger>
        <TooltipContent
          side="right"
          className="flex flex-col items-start gap-0.5"
        >
          <span>{node.title}</span>
          {hasDescription ? (
            <span className="text-xs text-muted-foreground">
              {node.description}
            </span>
          ) : null}
          {projectedConflictPath ? (
            <span className="text-xs text-muted-foreground">{node.path}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    );
  }

  // A folder row (Page with children, or bare folder) toggles its children
  // with the chevron that replaces its icon on hover.
  const leading = expandable ? (
    <button
      type="button"
      aria-expanded={expanded}
      data-state={expanded ? "open" : "closed"}
      className="relative h-4 w-4 shrink-0 flex items-center justify-center"
      onClick={(event) => {
        event.stopPropagation();
        handleNodeOpenChange(!expanded);
      }}
    >
      <span className="group-hover/tree-item:opacity-0 transition-opacity">
        {iconElement}
      </span>
      <ChevronRight
        className={cn(
          "absolute inset-0 m-auto h-3 w-3 opacity-0 transition-all group-hover/tree-item:opacity-100",
          expanded && "rotate-90",
        )}
      />
    </button>
  ) : (
    iconElement
  );

  return (
    <>
      <SidebarMenuSubItem
        ref={measureRef}
        data-index={index}
        style={style}
        className="relative"
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {dropIndicator}
        <div ref={setRowRef} className="flex items-center group/tree-item">
          {dragHandle}
          {withDescriptionTooltip(
            <SidebarMenuSubButton
              data-svode-resource-drag-source={isEditing ? undefined : true}
              draggable={!isEditing}
              isActive={isActive}
              aria-label={
                projectedConflictPath
                  ? `${node.title}. ${m.editor_name_existing_conflict({ path: node.path })}`
                  : undefined
              }
              className={cn(
                "flex-1",
                projectedConflictPath && "h-auto min-h-7 py-1",
                !isEditing && "cursor-pointer active:cursor-grabbing",
                nestHighlight,
              )}
              onDragStart={isEditing ? undefined : handleResourceDragStart}
              onClick={handlePageClick}
              onDoubleClick={handleStartRename}
            >
              {leading}
              {titleElement}
              {dot}
            </SidebarMenuSubButton>,
          )}
          {contextMenu}
        </div>
      </SidebarMenuSubItem>
      <ContentDeleteDialog
        confirmation={deleteConfirmation}
        onCancel={cancelDelete}
        onConfirm={(path) => void handleDeleteConfirm(path)}
      />
    </>
  );
}

/**
 * A row shows its node, not the children attached to it, so a node that
 * changed only below it keeps the row as it is.
 */
function sameRowNode(previous: TreeNode, next: TreeNode): boolean {
  if (previous === next) return true;
  const previousKeys = Object.keys(previous) as (keyof TreeNode)[];
  if (previousKeys.length !== Object.keys(next).length) return false;
  for (const key of previousKeys) {
    if (key === "children") continue;
    if (previous[key] !== next[key]) return false;
  }
  return treeNodeHasChildren(previous) === treeNodeHasChildren(next);
}

function sameRowProps(
  previous: FileTreeItemProps,
  next: FileTreeItemProps,
): boolean {
  for (const key of Object.keys(next) as (keyof FileTreeItemProps)[]) {
    if (key === "node") continue;
    if (previous[key] !== next[key]) return false;
  }
  return sameRowNode(previous.node, next.node);
}

export const FileTreeItem = memo(FileTreeItemRow, sameRowProps);

interface TreeChildLoadingRowProps {
  depth: number;
  index: number;
  /** Which of the two placeholders this is. */
  position: number;
  offset: number;
  measureRef: (element: HTMLLIElement | null) => void;
}

/** A placeholder row of a folder whose children are loading. */
export function TreeChildLoadingRow({
  depth,
  index,
  position,
  offset,
  measureRef,
}: TreeChildLoadingRowProps) {
  return (
    <SidebarMenuSubItem
      ref={measureRef}
      data-index={index}
      style={treeRowStyle(depth, offset)}
    >
      <div className="flex h-7 items-center gap-2 rounded-md px-2">
        <Skeleton className="size-4" />
        <Skeleton className={position === 0 ? "h-3 w-24" : "h-3 w-20"} />
      </div>
    </SidebarMenuSubItem>
  );
}
