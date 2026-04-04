import { useState, useCallback, useRef, useMemo, createContext, useEffect } from "react";
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
  type DragMoveEvent,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import { useEditorStore } from "@/stores/editor";
import type { TreeNode } from "@/types/workspace";
import {
  flattenTree,
  removeCollapsedChildren,
  getProjection,
  isDescendantOf,
  getParentDir,
  type FlattenedItem,
  type Projection,
} from "./tree-dnd-utilities";

// --- Context for sharing DnD state with FileTreeItem ---

interface TreeDndContextValue {
  activeId: string | null;
  activeFolderPath: string | null; // folder path of active item (if it's a folder)
  overId: string | null;
  projection: Projection | null;
  flatItems: FlattenedItem[];
  flatItemsMap: Map<string, FlattenedItem>;
}

export const TreeDndContext = createContext<TreeDndContextValue>({
  activeId: null,
  activeFolderPath: null,
  overId: null,
  projection: null,
  flatItems: [],
  flatItemsMap: new Map(),
});

// --- Props ---

interface SortableFileTreeProps {
  workspaceId: string;
  tree: TreeNode[];
  children: React.ReactNode;
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
      const nodeDir = node.path.replace(/\/readme\.md$/i, "");
      const childOrder = buildOrderMap(node.children, nodeDir);
      Object.assign(order, childOrder);
    }
  }
  return order;
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

export function SortableFileTree({
  workspaceId,
  tree,
  children,
}: SortableFileTreeProps) {
  const { moveEntry, saveOrder, refreshTree, toggleExpanded, expandedPaths } =
    useWorkspaceStore();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);
  const [projection, setProjection] = useState<Projection | null>(null);
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs to avoid stale closures in drag handlers
  const overIdRef = useRef<string | null>(null);
  const offsetLeftRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const projectionRef = useRef<Projection | null>(null);

  // Auto-scroll refs
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const scrollSpeed = useRef(0);

  useEffect(() => {
    scrollContainerRef.current = document.querySelector(
      '[data-slot="sidebar-content"]',
    );
    return () => {
      if (autoExpandTimer.current) clearTimeout(autoExpandTimer.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  // Flatten tree and filter out collapsed children
  const expandedSet = useMemo(() => {
    return new Set(expandedPaths[workspaceId] ?? []);
  }, [expandedPaths, workspaceId]);

  const flatItems = useMemo(() => {
    const all = flattenTree(tree);
    return removeCollapsedChildren(all, expandedSet);
  }, [tree, expandedSet]);

  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;

  const flatItemsMap = useMemo(
    () => new Map(flatItems.map((i) => [i.path, i])),
    [flatItems],
  );

  const sortableIds = useMemo(() => flatItems.map((i) => i.path), [flatItems]);

  // Compute projection using refs (always fresh values)
  const computeProjection = useCallback(() => {
    const aId = activeIdRef.current;
    const oId = overIdRef.current;
    const offset = offsetLeftRef.current;
    if (aId && oId) {
      const proj = getProjection(flatItemsRef.current, aId, oId, offset);
      setProjection(proj);
      projectionRef.current = proj;
    } else {
      setProjection(null);
      projectionRef.current = null;
    }
  }, []);

  // --- Auto-scroll ---

  const startAutoScroll = useCallback((speed: number) => {
    scrollSpeed.current = speed;
    if (rafRef.current !== null) return;
    const tick = () => {
      scrollContainerRef.current?.scrollBy(0, scrollSpeed.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    scrollSpeed.current = 0;
  }, []);

  // --- Drag handlers ---

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    setOverId(id);
    setOffsetLeft(0);
    setProjection(null);
    activeIdRef.current = id;
    overIdRef.current = id;
    offsetLeftRef.current = 0;
    projectionRef.current = null;
  }, []);

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      // Update offset
      offsetLeftRef.current = event.delta.x;
      setOffsetLeft(event.delta.x);

      // Update over if available from event
      if (event.over) {
        const newOver = event.over.id as string;
        overIdRef.current = newOver;
        setOverId(newOver);
      }

      // Recompute projection with fresh refs
      computeProjection();

      // Auto-scroll
      const container = scrollContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const mouseY =
          event.activatorEvent instanceof MouseEvent
            ? (event.activatorEvent as MouseEvent).clientY + event.delta.y
            : 0;
        const EDGE = 40;
        const SPEED = 5;
        if (mouseY > 0 && mouseY < rect.top + EDGE) {
          startAutoScroll(-SPEED);
        } else if (mouseY > 0 && mouseY > rect.bottom - EDGE) {
          startAutoScroll(SPEED);
        } else {
          stopAutoScroll();
        }
      }
    },
    [computeProjection, startAutoScroll, stopAutoScroll],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const newOverId = (event.over?.id as string) ?? null;
      overIdRef.current = newOverId;
      setOverId(newOverId);

      // Recompute with fresh refs
      computeProjection();

      // Auto-expand collapsed folders after 500ms hover
      if (autoExpandTimer.current) {
        clearTimeout(autoExpandTimer.current);
        autoExpandTimer.current = null;
      }
      if (newOverId) {
        const overNode = findNode(tree, newOverId);
        if (overNode && overNode.children.length > 0 && !expandedSet.has(newOverId)) {
          autoExpandTimer.current = setTimeout(() => {
            toggleExpanded(workspaceId, newOverId);
          }, 500);
        }
      }
    },
    [tree, workspaceId, toggleExpanded, expandedSet, computeProjection],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const currentProjection = projectionRef.current;
      resetState();

      const { active, over } = event;
      if (!over || active.id === over.id || !currentProjection) return;

      const workspace = useWorkspaceStore.getState().workspaces.find(
        (w) => w.id === workspaceId,
      );
      if (!workspace) return;

      const fromPath = active.id as string;
      const fromNode = findNode(tree, fromPath);
      if (!fromNode) return;

      // Guard: prevent dropping a folder into its own descendants
      const fromFolderPath = fromNode.children.length > 0
        ? fromPath.replace(/\/readme\.md$/i, "")
        : fromPath;
      if (isDescendantOf(currentProjection.parentPath, fromFolderPath)) {
        return;
      }

      // For folder documents (path = "folder/readme.md"), tree parent is parent of folder, not folder itself
      const fromParent = fromNode.children.length > 0
        ? getParentDir(fromPath.replace(/\/readme\.md$/i, ""))
        : getParentDir(fromPath);
      const toParent = currentProjection.parentPath;

      try {
        const { activeDocument, openDocument, closeDocument } = useLayoutStore.getState();
        const { clearUnsaved } = useEditorStore.getState();

        // Auto-nest: if nesting into a non-folder file, convert it first
        // Skip for bare folders (path doesn't end with .md) — they're already directories
        if (currentProjection.type === "child") {
          const targetNode = findNode(tree, currentProjection.overPath);
          const targetIsBareFolder = targetNode && !targetNode.path.endsWith(".md");
          if (targetNode && targetNode.children.length === 0 && !targetIsBareFolder) {
            const nestTarget = currentProjection.overPath;
            const oldName = targetNode.name; // e.g. "doc2.md"
            const newNestPath = await invoke<string>("nest_entry", {
              workspace: workspace.path,
              path: nestTarget,
            });
            if (activeDocument === nestTarget) {
              clearUnsaved(nestTarget);
              openDocument(newNestPath);
            }
            // Update order.json: rename "doc2.md" → "doc2" (file → folder)
            const newName = oldName.replace(/\.md$/i, "");
            if (newName !== oldName) {
              const order = buildOrderMap(tree);
              for (const siblings of Object.values(order)) {
                const idx = siblings.indexOf(oldName);
                if (idx !== -1) {
                  siblings[idx] = newName;
                  break;
                }
              }
              await saveOrder(workspaceId, order);
            }
            // Refresh tree after nest — structure changed on disk
            await refreshTree(workspaceId);
          }
        }

        // Use fresh tree from store (may have changed after nest_entry)
        const currentTree = useWorkspaceStore.getState().fileTrees[workspaceId] ?? tree;

        if (fromParent === toParent) {
          // Same parent — reorder
          const overPath = currentProjection.overPath;
          const overNode = findNode(currentTree, overPath);
          if (!overNode) return;

          const order = buildOrderMap(currentTree);
          const dirKey = toParent || ".";
          const siblings = order[dirKey];
          if (siblings) {
            const fromIdx = siblings.indexOf(fromNode.name);
            const overIdx = siblings.indexOf(overNode.name);
            if (fromIdx !== -1 && overIdx !== -1 && fromIdx !== overIdx) {
              siblings.splice(fromIdx, 1);
              const adjustedIdx =
                fromIdx < overIdx ? overIdx - 1 : overIdx;
              siblings.splice(
                currentProjection.type === "after" ? adjustedIdx + 1 : adjustedIdx,
                0,
                fromNode.name,
              );
              await saveOrder(workspaceId, order);
              await refreshTree(workspaceId);
            }
          }
          return;
        }

        // Different parent — move entry
        const oldParentReadme = fromParent
          ? `${fromParent}/readme.md`
          : null;

        // For document folders, move the folder itself, not just readme.md
        // Bare folders (path without .md) are already folder paths
        const isBareFolder = !fromPath.endsWith(".md");
        const isDocFolder = !isBareFolder && fromNode.children.length > 0;
        const movePath = isDocFolder
          ? fromPath.replace(/\/readme\.md$/i, "")
          : fromPath;

        // If the moved file is the open document, update path
        if (activeDocument === fromPath) {
          clearUnsaved(fromPath);
        }

        const newPath = await moveEntry(workspaceId, movePath, toParent);

        if (activeDocument === fromPath && newPath && !isBareFolder) {
          // moveEntry returns folder path for doc folders, append readme.md
          const newDocPath = isDocFolder ? `${newPath}/readme.md` : newPath;
          openDocument(newDocPath);
        }

        // Auto-unnest: if the old parent folder now has no children
        if (oldParentReadme) {
          const freshTree = useWorkspaceStore.getState().fileTrees[workspaceId] ?? currentTree;
          const oldParentNode = findNode(freshTree, oldParentReadme);
          if (oldParentNode && oldParentNode.children.length <= 1) {
            try {
              const currentActive = useLayoutStore.getState().activeDocument;
              const unnestPath = await invoke<string>("unnest_entry", {
                workspace: workspace.path,
                path: oldParentReadme,
              });
              if (currentActive === oldParentReadme) {
                useEditorStore.getState().clearUnsaved(oldParentReadme);
                useLayoutStore.getState().openDocument(unnestPath);
              }
              await refreshTree(workspaceId);
            } catch {
              // Unnest may fail if folder still has children (e.g. non-md files on disk)
            }
          }
        }

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
    resetState();
  }, []);

  function resetState() {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    setProjection(null);
    activeIdRef.current = null;
    overIdRef.current = null;
    offsetLeftRef.current = 0;
    projectionRef.current = null;
    stopAutoScroll();
    if (autoExpandTimer.current) {
      clearTimeout(autoExpandTimer.current);
      autoExpandTimer.current = null;
    }
  }

  const activeNode = activeId ? findNode(tree, activeId) : null;

  // If dragging a folder, compute its folder path for disabling children
  const activeFolderPath = useMemo(() => {
    if (!activeId || !activeNode || activeNode.children.length === 0) return null;
    return activeId.replace(/\/readme\.md$/i, "");
  }, [activeId, activeNode]);

  const contextValue = useMemo<TreeDndContextValue>(
    () => ({ activeId, activeFolderPath, overId, projection, flatItems, flatItemsMap }),
    [activeId, activeFolderPath, overId, projection, flatItems, flatItemsMap],
  );

  // Cross-workspace not-allowed cursor: when dragging starts, mark other workspace trees
  useEffect(() => {
    if (!activeId) return;
    const others = document.querySelectorAll(
      `[data-dnd-workspace]:not([data-dnd-workspace="${workspaceId}"])`,
    );
    others.forEach((el) => el.classList.add("dnd-not-allowed"));
    return () => {
      others.forEach((el) => el.classList.remove("dnd-not-allowed"));
    };
  }, [activeId, workspaceId]);

  return (
    <TreeDndContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableIds}>
          <div data-dnd-workspace={workspaceId}>
            {children}
          </div>
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
    </TreeDndContext.Provider>
  );
}

export { buildOrderMap };
