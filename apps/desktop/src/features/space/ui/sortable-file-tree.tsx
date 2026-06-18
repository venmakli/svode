import {
  useState,
  useCallback,
  useRef,
  useMemo,
  createContext,
  useEffect,
} from "react";
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
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { useSpaceStore } from "../model";
import { useEntrySelectionStore } from "@/features/entry";
import { useEditorStore } from "@/features/editor";
import type { TreeNode } from "@/features/entry";
import {
  flattenTree,
  removeCollapsedChildren,
  getProjection,
  isDescendantOf,
  getParentDir,
  type FlattenedItem,
  type Projection,
} from "../lib/tree-dnd-utilities";
import { treeNodeHasChildren } from "../lib/tree-cache";
import { logTiming, nowMs } from "@/shared/lib/performance";

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
  spaceId: string;
  tree: TreeNode[];
  children: React.ReactNode;
}

/**
 * Build order map from the current tree state.
 * Each directory key maps to its children names in order.
 */
function buildOrderMap(
  nodes: TreeNode[],
  dirKey = ".",
): Record<string, string[]> {
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

/** Find the parent tree node that directly contains a child with the given path. */
function findParentOf(nodes: TreeNode[], childPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.children.some((c) => c.path === childPath)) return node;
    const found = findParentOf(node.children, childPath);
    if (found) return found;
  }
  return null;
}

export function SortableFileTree({
  spaceId,
  tree,
  children,
}: SortableFileTreeProps) {
  const renderStartedAt = nowMs();
  const {
    moveEntry,
    saveOrder,
    refreshTree,
    loadTreeChildren,
    toggleExpanded,
    expandedPaths,
  } = useSpaceStore();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
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
    return new Set(expandedPaths[spaceId] ?? []);
  }, [expandedPaths, spaceId]);

  const flatItems = useMemo(() => {
    const all = flattenTree(tree);
    return removeCollapsedChildren(all, expandedSet);
  }, [tree, expandedSet]);

  const flatItemsRef = useRef(flatItems);

  useEffect(() => {
    flatItemsRef.current = flatItems;
  }, [flatItems]);

  const flatItemsMap = useMemo(
    () => new Map(flatItems.map((i) => [i.path, i])),
    [flatItems],
  );

  const sortableIds = useMemo(() => flatItems.map((i) => i.path), [flatItems]);

  useEffect(() => {
    logTiming("tree.render", renderStartedAt, {
      spaceId,
      rootNodes: tree.length,
      visibleNodes: flatItems.length,
    });
  });

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
        if (
          overNode &&
          treeNodeHasChildren(overNode) &&
          !expandedSet.has(newOverId)
        ) {
          autoExpandTimer.current = setTimeout(() => {
            void loadTreeChildren(spaceId, newOverId);
            toggleExpanded(spaceId, newOverId);
          }, 500);
        }
      }
    },
    [
      tree,
      spaceId,
      loadTreeChildren,
      toggleExpanded,
      expandedSet,
      computeProjection,
    ],
  );

  const resetState = useCallback(() => {
    setActiveId(null);
    setOverId(null);
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
  }, [stopAutoScroll]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const currentProjection = projectionRef.current;
      resetState();

      const { active, over } = event;
      if (!over || active.id === over.id || !currentProjection) return;

      const state = useSpaceStore.getState();
      const space =
        state.spaces.find((w) => w.id === spaceId) ??
        state.rootSpaces.find((w) => w.id === spaceId);
      if (!space) return;

      const fromPath = active.id as string;
      const fromNode = findNode(tree, fromPath);
      if (!fromNode) return;

      // Guard: prevent dropping a folder into its own descendants
      const fromFolderPath = treeNodeHasChildren(fromNode)
        ? fromPath.replace(/\/readme\.md$/i, "")
        : fromPath;
      if (isDescendantOf(currentProjection.parentPath, fromFolderPath)) {
        return;
      }

      // For folder documents (path = "folder/readme.md"), tree parent is parent of folder, not folder itself
      const fromParent = treeNodeHasChildren(fromNode)
        ? getParentDir(fromPath.replace(/\/readme\.md$/i, ""))
        : getParentDir(fromPath);
      const toParent = currentProjection.parentPath;

      try {
        const { activeDocument, openDocument } =
          useEntrySelectionStore.getState();
        const { clearUnsaved, suppressPaths } = useEditorStore.getState();

        // Auto-nest: if nesting into a non-folder file, convert it first
        // Skip for bare folders (path doesn't end with .md) — they're already directories
        if (currentProjection.type === "child") {
          const targetNode = findNode(tree, currentProjection.overPath);
          const targetIsBareFolder =
            targetNode && !targetNode.path.endsWith(".md");
          if (
            targetNode &&
            !treeNodeHasChildren(targetNode) &&
            !targetIsBareFolder
          ) {
            const nestTarget = currentProjection.overPath;
            const oldName = targetNode.name; // e.g. "doc2.md"
            // Suppress file watcher for structural change
            suppressPaths([nestTarget, fromPath]);
            const newNestPath = await invoke<string>("nest_entry", {
              space: space.path,
              path: nestTarget,
              projectPath: useSpaceStore.getState().activeRootPath,
            });
            suppressPaths([newNestPath]);
            if (activeDocument === nestTarget) {
              clearUnsaved(nestTarget);
              openDocument(newNestPath, spaceId);
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
              await saveOrder(spaceId, order);
            }
            // Refresh tree after nest — structure changed on disk
            await refreshTree(spaceId);
          }
        }

        // Use fresh tree from store (may have changed after nest_entry)
        const currentTree = useSpaceStore.getState().fileTrees[spaceId] ?? tree;

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
              const adjustedIdx = fromIdx < overIdx ? overIdx - 1 : overIdx;
              siblings.splice(
                currentProjection.type === "after"
                  ? adjustedIdx + 1
                  : adjustedIdx,
                0,
                fromNode.name,
              );
              await saveOrder(spaceId, order);
              await refreshTree(spaceId);
            }
          }
          return;
        }

        // Different parent — move entry
        // Use actual tree node path (preserves readme.md case from filesystem)
        const oldParentTreeNode = fromParent
          ? findParentOf(tree, fromPath)
          : null;
        const oldParentReadme = oldParentTreeNode?.path
          .toLowerCase()
          .endsWith("/readme.md")
          ? oldParentTreeNode.path
          : null;

        // For document folders, move the folder itself, not just readme.md
        // Bare folders (path without .md) are already folder paths
        const isBareFolder = !fromPath.endsWith(".md");
        const isDocFolder = !isBareFolder && treeNodeHasChildren(fromNode);
        const movePath = isDocFolder
          ? fromPath.replace(/\/readme\.md$/i, "")
          : fromPath;

        // If the moved file is the open document, update path
        if (activeDocument === fromPath) {
          clearUnsaved(fromPath);
        }

        // Suppress file watcher for structural move
        suppressPaths([fromPath, movePath]);
        const newPath = await moveEntry(spaceId, movePath, toParent);
        if (newPath) suppressPaths([newPath]);

        if (activeDocument === fromPath && newPath && !isBareFolder) {
          // moveEntry returns folder path for doc folders, append readme filename (preserve case)
          const readmeFilename = fromPath.split("/").pop() ?? "README.md";
          const newDocPath = isDocFolder
            ? `${newPath}/${readmeFilename}`
            : newPath;
          openDocument(newDocPath, spaceId);
        }

        // Auto-unnest: if the old parent folder now has no children
        if (oldParentReadme) {
          const freshTree =
            useSpaceStore.getState().fileTrees[spaceId] ?? currentTree;
          const oldParentNode = findNode(freshTree, oldParentReadme);
          if (oldParentNode && oldParentNode.children.length <= 1) {
            try {
              const currentActive =
                useEntrySelectionStore.getState().activeDocument;
              useEditorStore.getState().suppressPaths([oldParentReadme]);
              const unnestPath = await invoke<string>("unnest_entry", {
                space: space.path,
                path: oldParentReadme,
                projectPath: useSpaceStore.getState().activeRootPath,
              });
              useEditorStore.getState().suppressPaths([unnestPath]);
              if (currentActive === oldParentReadme) {
                useEditorStore.getState().clearUnsaved(oldParentReadme);
                useEntrySelectionStore
                  .getState()
                  .openDocument(unnestPath, spaceId);
              }
              await refreshTree(spaceId);
            } catch {
              // Unnest may fail if folder still has children (e.g. non-md files on disk)
            }
          }
        }

        const updatedTree = useSpaceStore.getState().fileTrees[spaceId];
        if (updatedTree) {
          const order = buildOrderMap(updatedTree);
          await saveOrder(spaceId, order);
        }
      } catch (err) {
        console.error("Failed to move entry:", err);
        toast.error("Failed to move file");
      }
    },
    [tree, spaceId, moveEntry, saveOrder, refreshTree, resetState],
  );

  const handleDragCancel = useCallback(() => {
    resetState();
  }, [resetState]);

  const activeNode = activeId ? findNode(tree, activeId) : null;

  // If dragging a folder, compute its folder path for disabling children
  const activeFolderPath = useMemo(() => {
    if (!activeId || !activeNode || !treeNodeHasChildren(activeNode))
      return null;
    return activeId.replace(/\/readme\.md$/i, "");
  }, [activeId, activeNode]);

  const contextValue = useMemo<TreeDndContextValue>(
    () => ({
      activeId,
      activeFolderPath,
      overId,
      projection,
      flatItems,
      flatItemsMap,
    }),
    [activeId, activeFolderPath, overId, projection, flatItems, flatItemsMap],
  );

  // Cross-space not-allowed cursor: when dragging starts, mark other space trees
  useEffect(() => {
    if (!activeId) return;
    const others = document.querySelectorAll(
      `[data-dnd-space]:not([data-dnd-space="${spaceId}"])`,
    );
    others.forEach((el) => el.classList.add("dnd-not-allowed"));
    return () => {
      others.forEach((el) => el.classList.remove("dnd-not-allowed"));
    };
  }, [activeId, spaceId]);

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
          <div data-dnd-space={spaceId}>{children}</div>
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
