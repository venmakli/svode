import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { TreeNode } from "../model/types";
import { useShallowStableArray } from "@/shared/hooks/use-shallow-stable-array";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { treeNodeHasChildren, treeParentKeyForNode } from "../lib/tree-cache";
import {
  flattenTree,
  getProjection,
  removeDescendantsOf,
  removeCollapsedChildren,
  isDescendantOf,
  type ProjectionIntent,
  type Projection,
} from "../lib/tree-dnd-utilities";
import { useSpaceStore } from "../model";
import { useSortableFileTreeActions } from "./use-sortable-file-tree-actions";

/** What the drag shows on one row of the tree. */
export interface FileTreeRowDndState {
  /** A child of the dragged folder is not a drop target. */
  sortableDisabled: boolean;
  /** Where the drop line is drawn on this row, if it is the over row. */
  dropType: "before" | "after" | null;
  /** Depth of the projected place relative to this row. */
  dropRelativeDepth: number;
  nestTarget: boolean;
}

export const IDLE_ROW_DND_STATE: FileTreeRowDndState = {
  sortableDisabled: false,
  dropType: null,
  dropRelativeDepth: 0,
  nestTarget: false,
};

// A new options object would give every render new activators, and every
// sortable row would render again with them.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };

interface UseSortableFileTreeDndInput {
  spaceId: string;
  tree: TreeNode[];
  expandedSet: Set<string>;
  nodeByPath: ReadonlyMap<string, TreeNode>;
}

export function useSortableFileTreeDnd({
  spaceId,
  tree,
  expandedSet,
  nodeByPath,
}: UseSortableFileTreeDndInput) {
  const renderStartedAt = nowMs();
  const loadTreeChildren = useSpaceStore((state) => state.loadTreeChildren);
  const toggleExpanded = useSpaceStore((state) => state.toggleExpanded);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeIdRef = useRef<string | null>(null);
  const offsetLeftRef = useRef(0);
  const overIdRef = useRef<string | null>(null);
  const projectionRef = useRef<Projection | null>(null);
  const projectionIntentRef = useRef<ProjectionIntent | null>(null);

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

  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));

  const flatItems = useMemo(() => {
    const all = flattenTree(tree);
    const visible = removeCollapsedChildren(all, expandedSet);
    return removeDescendantsOf(visible, activeId);
  }, [activeId, tree, expandedSet]);

  const flatItemsRef = useRef(flatItems);

  useEffect(() => {
    flatItemsRef.current = flatItems;
  }, [flatItems]);

  const flatItemsMap = useMemo(
    () => new Map(flatItems.map((item) => [item.path, item])),
    [flatItems],
  );

  // Every sortable row reads the ids through the sortable context, so the
  // list keeps its identity while the ids stay the same.
  const sortableIds = useShallowStableArray(
    useMemo(() => flatItems.map((item) => item.path), [flatItems]),
  );

  useEffect(() => {
    logTiming("tree.render", renderStartedAt, {
      spaceId,
      rootNodes: tree.length,
      visibleNodes: flatItems.length,
    });
  });

  const computeProjection = useCallback(() => {
    const activePath = activeIdRef.current;
    const overPath = overIdRef.current;
    const offset = offsetLeftRef.current;
    if (activePath && overPath) {
      const nextProjection = getProjection(
        flatItemsRef.current,
        activePath,
        overPath,
        offset,
        projectionIntentRef.current,
      );
      setProjection(nextProjection);
      projectionRef.current = nextProjection;
    } else {
      setProjection(null);
      projectionRef.current = null;
    }
  }, []);

  const collisionDetection = useCallback<CollisionDetection>(
    ({ collisionRect, droppableContainers, droppableRects, pointerCoordinates }) => {
      const y =
        pointerCoordinates?.y ?? collisionRect.top + collisionRect.height / 2;
      const orderedVisibleIds = new Map(
        flatItemsRef.current.map((item, index) => [item.path, index]),
      );

      const collisions: Array<
        Collision & {
          data: {
            value: number;
            placement: ProjectionIntent["placement"];
            allowChild: boolean;
          };
        }
      > = [];

      for (const droppableContainer of droppableContainers) {
        const index = orderedVisibleIds.get(String(droppableContainer.id));
        if (index === undefined) continue;

        const rect = droppableRects.get(droppableContainer.id);
        if (!rect) continue;

        const centerY = rect.top + rect.height / 2;
        const distance =
          y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
        const placement: ProjectionIntent["placement"] =
          y < centerY ? "before" : "after";
        const allowChild =
          y >= rect.top + rect.height * 0.25 &&
          y <= rect.bottom - rect.height * 0.25;

        collisions.push({
          id: droppableContainer.id,
          data: {
            value: distance * 1000 + Math.abs(centerY - y) + index / 1000,
            placement,
            allowChild,
          },
        });
      }

      collisions.sort((left, right) => left.data.value - right.data.value);

      const first = collisions[0];
      projectionIntentRef.current = first
        ? {
            placement: first.data.placement,
            allowChild: first.data.allowChild,
          }
        : null;

      return collisions;
    },
    [],
  );

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    setOverId(id);
    setProjection(null);
    activeIdRef.current = id;
    overIdRef.current = id;
    offsetLeftRef.current = 0;
    projectionRef.current = null;
    projectionIntentRef.current = null;
  }, []);

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      offsetLeftRef.current = event.delta.x;

      if (event.over) {
        const nextOverId = event.over.id as string;
        overIdRef.current = nextOverId;
        setOverId(nextOverId);
      }

      computeProjection();

      const container = scrollContainerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseY =
        event.activatorEvent instanceof MouseEvent
          ? event.activatorEvent.clientY + event.delta.y
          : 0;
      const edge = 40;
      const speed = 5;
      if (mouseY > 0 && mouseY < rect.top + edge) {
        startAutoScroll(-speed);
      } else if (mouseY > 0 && mouseY > rect.bottom - edge) {
        startAutoScroll(speed);
      } else {
        stopAutoScroll();
      }
    },
    [computeProjection, startAutoScroll, stopAutoScroll],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const nextOverId = (event.over?.id as string) ?? null;
      overIdRef.current = nextOverId;
      setOverId(nextOverId);

      computeProjection();

      if (autoExpandTimer.current) {
        clearTimeout(autoExpandTimer.current);
        autoExpandTimer.current = null;
      }
      if (!nextOverId) return;

      const overNode = nodeByPath.get(nextOverId);
      if (
        !overNode ||
        !treeNodeHasChildren(overNode) ||
        expandedSet.has(nextOverId)
      ) {
        return;
      }

      autoExpandTimer.current = setTimeout(() => {
        void loadTreeChildren(spaceId, nextOverId);
        toggleExpanded(spaceId, nextOverId);
      }, 500);
    },
    [
      computeProjection,
      expandedSet,
      loadTreeChildren,
      nodeByPath,
      spaceId,
      toggleExpanded,
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
    projectionIntentRef.current = null;
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

  const activeNode = activeId ? (nodeByPath.get(activeId) ?? null) : null;

  const activeFolderPath = useMemo(() => {
    if (!activeId || !activeNode) return null;
    return treeParentKeyForNode(activeNode);
  }, [activeId, activeNode]);

  const rowDndState = useCallback(
    (path: string): FileTreeRowDndState => {
      if (activeId === null) return IDLE_ROW_DND_STATE;
      const sortableDisabled =
        !!activeFolderPath &&
        path !== activeId &&
        isDescendantOf(path, activeFolderPath);
      // projection.overPath is the source of truth for the nest highlight.
      const nestTarget =
        projection?.overPath === path && projection.type === "child";
      const overProjection = overId === path ? projection : null;
      const dropType =
        overProjection && overProjection.type !== "child"
          ? overProjection.type
          : null;
      if (!sortableDisabled && !nestTarget && !dropType) {
        return IDLE_ROW_DND_STATE;
      }
      return {
        sortableDisabled,
        dropType,
        dropRelativeDepth:
          dropType && overProjection
            ? overProjection.depth - (flatItemsMap.get(path)?.depth ?? 0)
            : 0,
        nestTarget,
      };
    },
    [activeFolderPath, activeId, flatItemsMap, overId, projection],
  );

  useEffect(() => {
    if (!activeId) return;
    const others = document.querySelectorAll(
      `[data-dnd-space]:not([data-dnd-space="${spaceId}"])`,
    );
    others.forEach((element) => element.classList.add("dnd-not-allowed"));
    return () => {
      others.forEach((element) =>
        element.classList.remove("dnd-not-allowed"),
      );
    };
  }, [activeId, spaceId]);

  return {
    activeId,
    activeNode,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragOver,
    handleDragStart,
    collisionDetection,
    rowDndState,
    sensors,
    sortableIds,
  };
}
