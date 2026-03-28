import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { ChevronRight, Ellipsis, FileText, FilePlus, GripVertical } from "lucide-react";
import { useLayoutStore } from "@/stores/layout";
import { useEditorStore } from "@/stores/editor";
import { useWorkspaceStore } from "@/stores/workspace";
import type { TreeNode } from "@/types/workspace";

interface FileTreeItemProps {
  node: TreeNode;
  workspaceId: string;
}

export function FileTreeItem({ node, workspaceId }: FileTreeItemProps) {
  const { openDocument, activeDocument } = useLayoutStore();
  const { unsavedChanges, aiModified } = useEditorStore();
  const { expandedPaths, toggleExpanded, refreshTree, workspaces } =
    useWorkspaceStore();

  const isActive = activeDocument === node.path;
  const isUnsaved = !!unsavedChanges[node.path];
  const isAiModified = !!aiModified[node.path];
  const showDot = isUnsaved || isAiModified;

  const expanded = expandedPaths[workspaceId]?.includes(node.path) ?? false;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.path });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  const workspace = workspaces.find((w) => w.id === workspaceId);

  async function handleCreateSubpage() {
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
      console.error("Failed to create sub-page:", err);
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
      className="flex h-7 w-4 shrink-0 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100 cursor-grab active:cursor-grabbing"
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
        <DropdownMenuItem onClick={handleCreateSubpage}>
          <FilePlus className="mr-2 h-4 w-4" />
          {m.workspace_create_subpage()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (node.children.length === 0) {
    return (
      <SidebarMenuSubItem ref={setNodeRef} style={style}>
        <div className="flex items-center group/tree-item">
          {dragHandle}
          <SidebarMenuSubButton
            isActive={isActive}
            className="flex-1"
            onClick={() => openDocument(node.path)}
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
    <SidebarMenuSubItem ref={setNodeRef} style={style}>
      <Collapsible
        open={expanded}
        onOpenChange={() => toggleExpanded(workspaceId, node.path)}
        className="group/collapsible"
      >
        <div className="flex items-center group/tree-item">
          {dragHandle}
          <CollapsibleTrigger asChild>
            <button className="flex h-7 w-5 shrink-0 items-center justify-center">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]/collapsible:rotate-90" />
            </button>
          </CollapsibleTrigger>
          <SidebarMenuSubButton
            isActive={isActive}
            className="flex-1"
            onClick={() => openDocument(node.path)}
          >
            {iconElement}
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
