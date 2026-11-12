import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { estimateTreeRowHeight, type FileTreeRows } from "../lib/file-tree-rows";

const SIDEBAR_SCROLL_SELECTOR = '[data-slot="sidebar-content"]';
const OVERSCAN = 10;
// Rows shown before the scroll container is measured.
const INITIAL_VIEWPORT_HEIGHT = 800;

interface UseVirtualFileTreeInput {
  rows: FileTreeRows;
  /** Rows that stay mounted outside the visible area. */
  keepMountedPaths: readonly string[];
  /** The row of the active content, revealed when not opened from the tree. */
  revealPath: string | null;
  revealEnabled: boolean;
}

function sidebarScrollElement(list: HTMLElement | null): HTMLElement | null {
  return list?.closest<HTMLElement>(SIDEBAR_SCROLL_SELECTOR) ?? null;
}

/**
 * The trees of all Spaces share the scroll container of the sidebar, so each
 * list starts at its own offset in it, which moves when content above grows.
 */
function useListScrollMargin(listRef: { current: HTMLUListElement | null }) {
  const [scrollMargin, setScrollMargin] = useState(0);
  const update = useCallback(() => {
    const list = listRef.current;
    const scroller = sidebarScrollElement(list);
    if (!list || !scroller) return;
    const next = Math.round(
      list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop,
    );
    // Sub-pixel noise while scrolling is not a move of the list.
    setScrollMargin((current) =>
      Math.abs(current - next) < 1.5 ? current : next,
    );
  }, [listRef]);

  useLayoutEffect(update);

  useEffect(() => {
    const scroller = sidebarScrollElement(listRef.current);
    if (!scroller) return;
    const resizes =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observeChildren = () => {
      if (!resizes) return;
      resizes.disconnect();
      for (const child of scroller.children) resizes.observe(child);
    };
    observeChildren();
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observeChildren();
            update();
          });
    mutations?.observe(scroller, { childList: true });
    return () => {
      resizes?.disconnect();
      mutations?.disconnect();
    };
  }, [listRef, update]);

  return scrollMargin;
}

export function useVirtualFileTree({
  rows,
  keepMountedPaths,
  revealPath,
  revealEnabled,
}: UseVirtualFileTreeInput) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowsRef = useRef(rows);
  // Measured row heights by row key; the space above a row is not measured.
  const heightsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    rowsRef.current = rows;
  });

  const scrollMargin = useListScrollMargin(listRef);

  const keepMountedIndexes = useMemo(() => {
    const indexes: number[] = [];
    for (const path of keepMountedPaths) {
      const index = rows.indexByPath.get(path);
      if (index !== undefined) indexes.push(index);
    }
    return indexes.sort((left, right) => left - right);
  }, [keepMountedPaths, rows]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      const visible = defaultRangeExtractor(range);
      if (keepMountedIndexes.length === 0) return visible;
      return [...new Set([...visible, ...keepMountedIndexes])].sort(
        (left, right) => left - right,
      );
    },
    [keepMountedIndexes],
  );

  // The space above a row depends on its neighbours, so it is part of the
  // size key: a row that moves keeps its measured height, not its spacing.
  const getItemKey = useCallback(
    (index: number) => {
      const row = rows.rows[index];
      return `${row.key}\u0000${row.spaceBefore}`;
    },
    [rows],
  );

  const estimateSize = useCallback(
    (index: number) => {
      const row = rows.rows[index];
      return (
        row.spaceBefore +
        (heightsRef.current.get(row.key) ?? estimateTreeRowHeight(row))
      );
    },
    [rows],
  );

  const measureElement = useCallback(
    (
      element: Element,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<HTMLElement, Element>,
    ) => {
      const row = rowsRef.current.rows[instance.indexFromElement(element)];
      if (!row) return 0;
      const box = entry?.borderBoxSize?.[0];
      const measured = box
        ? Math.round(box.blockSize)
        : (element as HTMLElement).offsetHeight;
      // An element without layout keeps the estimate instead of collapsing.
      const height = measured > 0 ? measured : estimateTreeRowHeight(row);
      heightsRef.current.set(row.key, height);
      return row.spaceBefore + height;
    },
    [],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual intentionally returns an imperative virtualizer instance for this list.
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: rows.rows.length,
    getScrollElement: () => sidebarScrollElement(listRef.current),
    estimateSize,
    getItemKey,
    measureElement,
    rangeExtractor,
    scrollMargin,
    overscan: OVERSCAN,
    initialRect: {
      width: 0,
      height:
        typeof window === "undefined"
          ? INITIAL_VIEWPORT_HEIGHT
          : window.innerHeight || INITIAL_VIEWPORT_HEIGHT,
    },
  });

  const revealIndex =
    revealPath === null ? undefined : rows.indexByPath.get(revealPath);
  const revealIndexRef = useRef(revealIndex);
  useLayoutEffect(() => {
    revealIndexRef.current = revealIndex;
  });
  const revealable = revealIndex !== undefined;
  useEffect(() => {
    if (!revealable || !revealEnabled) return;
    const frame = window.requestAnimationFrame(() => {
      const index = revealIndexRef.current;
      if (index === undefined) return;
      virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [revealPath, revealable, revealEnabled, virtualizer]);

  return {
    listRef,
    virtualizer,
    virtualItems: virtualizer.getVirtualItems(),
    listHeight: virtualizer.getTotalSize() + rows.trailingSpace,
    scrollMargin,
  };
}
