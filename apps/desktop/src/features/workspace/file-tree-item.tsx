import { useContext } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, Ellipsis, FileText, FilePlus, GripVertical, Trash2 } from "lucide-react";
import { useLayoutStore } from "@/stores/layout";
import { useEditorStore } from "@/stores/editor";
import { useWorkspaceStore } from "@/stores/workspace";
import type { TreeNode } from "@/types/workspace";
import { TreeDndContext } from "./sortable-file-tree";
import { TreeDropIndicator } from "./tree-drop-indicator";
import { isDescendantOf } from "./tree-dnd-utilities";

interface FileTreeItemProps {
  node: TreeNode;
  workspaceId: string;
}

export function FileTreeItem({ node, workspaceId }: FileTreeItemProps) {
  const { openDocument, activeDocument } = useLayoutStore();
  const { unsavedChanges, aiModified } = useEditorStore();
  const { expandedPaths, toggleExpanded, refreshTree, workspaces, activeWorkspaceId } =
    useWorkspaceStore();

  const isActive = activeDocument === node.path;
  const isUnsaved = !!unsavedChanges[node.path];
  const isAiModified = !!aiModified[node.path];
  const showDot = isUnsaved || isAiModified;

  const expanded = expandedPaths[workspaceId]?.includes(node.path) ?? false;

  const { activeId, activeFolderPath, overId, projection, flatItemsMap } = useContext(TreeDndContext);

  // Disable sortable for children of the currently dragged folder
  const isChildOfDragged = !!activeFolderPath && isDescendantOf(node.path, activeFolderPath);

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: node.path, disabled: isChildOfDragged });
  const isOver = activeId !== null && overId === node.path;
  const myDepth = flatItemsMap.get(node.path)?.depth ?? 0;

  const style = {
    opacity: isDragging ? 0.4 : undefined,
  };

  const workspace = workspaces.find((w) => w.id === workspaceId);

  function handleDocumentClick() {
    if (activeWorkspaceId !== workspaceId) {
      useWorkspaceStore.getState().openWorkspace(workspaceId);
    }
    openDocument(node.path);
  }

  async function handleNewPage() {
    if (!workspace) return;
    try {
      let parentPath: string;
      if (node.children.length > 0) {
        // Already a folder — parent is the folder path
        parentPath = node.path.replace(/\/readme\.md$/i, "");
      } else {
        // File — nest it first, then create child
        const newPath = await invoke<string>("nest_entry", {
          workspace: workspace.path,
          path: node.path,
        });
        parentPath = newPath.replace(/\/readme\.md$/i, "");
      }
      // Create the sub-page
      await invoke("create_entry", {
        workspace: workspace.path,
        parentPath,
        title: "Untitled",
      });
      await refreshTree(workspaceId);
      // Expand the parent so the new child is visible
      if (!expandedPaths[workspaceId]?.includes(node.path)) {
        toggleExpanded(workspaceId, node.path);
      }
      toast.success(m.toast_page_created());
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDelete() {
    if (!workspace) return;
    try {
      await invoke("delete_entry", {
        workspace: workspace.path,
        path: node.path,
      });
      await refreshTree(workspaceId);
    } catch (err) {
      console.error("Failed to delete entry:", err);
      toast.error(m.toast_error());
    }
  }

  const iconElement = node.icon ? (
    <span className="h-4 w-4 shrink-0 text-center leading-4">{node.icon}</span>
  ) : (
    <FileText className="h-4 w-4 shrink-0" />
  );

  const dot = showDot ? (
    <span
      className={`ml-auto shrink-0 text-xs ${isUnsaved ? "text-red-500" : "text-blue-500"}`}
      title={isUnsaved ? "Unsaved changes" : "Modified externally"}
    >
      ●
    </span>
  ) : null;

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
        <DropdownMenuItem onClick={handleNewPage}>
          <FilePlus className="mr-2 h-4 w-4" />
          {m.workspace_new_page()}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={handleDelete}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {m.workspace_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Relative depth: how much deeper/shallower the projected position is
  // compared to this item's actual depth
  const relativeDepth = projection ? projection.depth - myDepth : 0;
  const isNestTarget = isOver && projection?.type === "child";
  const dropIndicator =
    isOver && projection && projection.type !== "child" ? (
      <TreeDropIndicator type={projection.type} relativeDepth={relativeDepth} />
    ) : null;

  const nestHighlight = isNestTarget ? "bg-sidebar-accent ring-1 ring-sidebar-primary/30 rounded-md" : "";

  if (node.children.length === 0) {
    return (
      <SidebarMenuSubItem ref={setNodeRef} style={style} className="relative">
        {dropIndicator}
        <div className="flex items-center group/tree-item">
          {dragHandle}
          <SidebarMenuSubButton
            isActive={isActive}
            className={`flex-1 ${nestHighlight}`}
            onClick={handleDocumentClick}
          >
            {iconElement}
            <span className="truncate">{node.title}</span>
            {dot}
          </SidebarMenuSubButton>
          {contextMenu}
        </div>
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuSubItem ref={setNodeRef} style={style} className="relative">
      {dropIndicator}
      <Collapsible
        open={expanded}
        onOpenChange={() => toggleExpanded(workspaceId, node.path)}
        className="group/collapsible"
      >
        <div className="flex items-center group/tree-item">
          {dragHandle}
          <SidebarMenuSubButton
            isActive={isActive}
            className={`flex-1 ${nestHighlight}`}
            onClick={handleDocumentClick}
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
            <span className="truncate">{node.title}</span>
            {dot}
          </SidebarMenuSubButton>
          {contextMenu}
        </div>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <FileTreeItem
                key={child.path}
                node={child}
                workspaceId={workspaceId}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuSubItem>
  );
}
