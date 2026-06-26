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
import { logTiming, nowMs } from "@/shared/lib/performance";
import { treeNodeHasChildren, treeParentKeyForNode } from "../lib/tree-cache";
import {
  flattenTree,
  getProjection,
  removeDescendantsOf,
  removeCollapsedChildren,
  type FlattenedItem,
  type ProjectionIntent,
  type Projection,
} from "../lib/tree-dnd-utilities";
import { findTreeNode } from "../lib/tree-node-queries";
import { useSpaceStore } from "../model";
import { useSortableFileTreeActions } from "./use-sortable-file-tree-actions";

export interface SortableFileTreeDndContextValue {
  activeFolderPath: string | null;
  activeId: string | null;
  flatItems: FlattenedItem[];
  flatItemsMap: Map<string, FlattenedItem>;
  overId: string | null;
  projection: Projection | null;
}

interface UseSortableFileTreeDndInput {
  spaceId: string;
  tree: TreeNode[];
}

export function useSortableFileTreeDnd({
  spaceId,
  tree,
}: UseSortableFileTreeDndInput) {
  const renderStartedAt = nowMs();
  const { loadTreeChildren, toggleExpanded, expandedPaths } = useSpaceStore();

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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const expandedSet = useMemo(() => {
    return new Set(expandedPaths[spaceId] ?? []);
  }, [expandedPaths, spaceId]);

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

  const sortableIds = useMemo(
    () => flatItems.map((item) => item.path),
    [flatItems],
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

      const overNode = findTreeNode(tree, nextOverId);
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
      spaceId,
      toggleExpanded,
      tree,
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

  const activeNode = activeId ? findTreeNode(tree, activeId) : null;

  const activeFolderPath = useMemo(() => {
    if (!activeId || !activeNode) return null;
    return treeParentKeyForNode(activeNode);
  }, [activeId, activeNode]);

  const contextValue = useMemo<SortableFileTreeDndContextValue>(
    () => ({
      activeFolderPath,
      activeId,
      flatItems,
      flatItemsMap,
      overId,
      projection,
    }),
    [activeFolderPath, activeId, flatItems, flatItemsMap, overId, projection],
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
    activeNode,
    contextValue,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragOver,
    handleDragStart,
    collisionDetection,
    sensors,
    sortableIds,
  };
}
