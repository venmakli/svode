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
import { FileText } from "lucide-react";
import { useSpaceStore } from "../model";
import type { TreeNode } from "@/features/entry";
import {
  flattenTree,
  removeCollapsedChildren,
  getProjection,
  type FlattenedItem,
  type Projection,
} from "../lib/tree-dnd-utilities";
import { treeNodeHasChildren } from "../lib/tree-cache";
import { findTreeNode } from "../lib/tree-node-queries";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { useSortableFileTreeActions } from "../hooks/use-sortable-file-tree-actions";

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

export function SortableFileTree({
  spaceId,
  tree,
  children,
}: SortableFileTreeProps) {
  const renderStartedAt = nowMs();
  const { loadTreeChildren, toggleExpanded, expandedPaths } = useSpaceStore();

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
        const overNode = findTreeNode(tree, newOverId);
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

  const commitDragEnd = useSortableFileTreeActions({
    spaceId,
    tree,
    resetState,
  });

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      void commitDragEnd(event, projectionRef.current);
    },
    [commitDragEnd],
  );

  const handleDragCancel = useCallback(() => {
    resetState();
  }, [resetState]);

  const activeNode = activeId ? findTreeNode(tree, activeId) : null;

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
