import { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import type { TreeNode } from "@/types/workspace";

interface SortableFileTreeProps {
  workspaceId: string;
  tree: TreeNode[];
  children: React.ReactNode;
}

/** Flatten tree into array of sortable IDs (node paths). */
function flattenIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.path);
    if (node.children.length > 0) {
      ids.push(...flattenIds(node.children));
    }
  }
  return ids;
}

/** Find a node in the tree by path. */
function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children.length > 0) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** Get the parent directory of a relative path. Returns "" for root-level items. */
function getParentDir(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "";
  // For paths like "folder/readme.md", the parent is "folder"
  // For paths like "folder/sub/readme.md", the parent is "folder/sub"
  parts.pop();
  return parts.join("/");
}

/**
 * Build order map from the current tree state.
 * Each directory key maps to its children names in order.
 */
function buildOrderMap(nodes: TreeNode[], dirKey = "."): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  order[dirKey] = nodes.map((n) => n.name);
  for (const node of nodes) {
    if (node.children.length > 0) {
      // Node's directory is the path without /readme.md
      const nodeDir = node.path.replace(/\/readme\.md$/i, "");
      const childOrder = buildOrderMap(node.children, nodeDir);
      Object.assign(order, childOrder);
    }
  }
  return order;
}

export function SortableFileTree({
  workspaceId,
  tree,
  children,
}: SortableFileTreeProps) {
  const { moveEntry, saveOrder, refreshTree, toggleExpanded } =
    useWorkspaceStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const ids = flattenIds(tree);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const ovPath = event.over?.id as string | undefined;

      // Auto-expand collapsed folders after 500ms hover
      if (autoExpandTimer.current) {
        clearTimeout(autoExpandTimer.current);
        autoExpandTimer.current = null;
      }
      if (ovPath) {
        const overNode = findNode(tree, ovPath);
        if (overNode && overNode.children.length > 0) {
          autoExpandTimer.current = setTimeout(() => {
            toggleExpanded(workspaceId, ovPath);
          }, 500);
        }
      }
    },
    [tree, workspaceId, toggleExpanded],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      if (autoExpandTimer.current) {
        clearTimeout(autoExpandTimer.current);
        autoExpandTimer.current = null;
      }

      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const fromPath = active.id as string;
      const overPath = over.id as string;
      const overNode = findNode(tree, overPath);
      if (!overNode) return;

      // Determine target parent:
      // If dropping on a folder (has children), nest inside it
      // If dropping on a file, place in the same parent directory
      let toParent: string;
      if (overNode.children.length > 0) {
        // Dropping on a folder — nest inside
        toParent = overNode.path.replace(/\/readme\.md$/i, "");
      } else {
        // Dropping on a file — same parent
        toParent = getParentDir(overNode.path);
      }

      // Same parent — reorder within the same folder
      if (getParentDir(fromPath) === toParent) {
        const fromNode = findNode(tree, fromPath);
        if (!fromNode) return;

        const order = buildOrderMap(tree);
        const dirKey = toParent || ".";
        const siblings = order[dirKey];
        if (siblings) {
          const fromIdx = siblings.indexOf(fromNode.name);
          const overIdx = siblings.indexOf(overNode.name);
          if (fromIdx !== -1 && overIdx !== -1 && fromIdx !== overIdx) {
            // Move item from old position to new position
            siblings.splice(fromIdx, 1);
            siblings.splice(overIdx, 0, fromNode.name);
            await saveOrder(workspaceId, order);
            await refreshTree(workspaceId);
          }
        }
        return;
      }

      try {
        await moveEntry(workspaceId, fromPath, toParent);
        // Rebuild order from refreshed tree
        const updatedTree = useWorkspaceStore.getState().fileTrees[workspaceId];
        if (updatedTree) {
          const order = buildOrderMap(updatedTree);
          await saveOrder(workspaceId, order);
        }
      } catch (err) {
        console.error("Failed to move entry:", err);
        toast.error("Failed to move file");
      }
    },
    [tree, workspaceId, moveEntry, saveOrder, refreshTree],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    if (autoExpandTimer.current) {
      clearTimeout(autoExpandTimer.current);
      autoExpandTimer.current = null;
    }
  }, []);

  const activeNode = activeId ? findNode(tree, activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeNode && (
          <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm shadow-md opacity-80">
            {activeNode.icon ? (
              <span className="h-4 w-4 shrink-0 text-center leading-4">
                {activeNode.icon}
              </span>
            ) : (
              <FileText className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{activeNode.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

export { buildOrderMap };
