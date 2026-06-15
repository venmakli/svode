import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type MouseEvent,
  type RefObject,
} from "react";
import { NodeApi } from "platejs";
import type { Heading } from "@platejs/toc";
import { useTocSideBarState, useTocSideBar } from "@platejs/toc/react";
import { cn } from "@/shared/lib/utils";

interface TocSidebarProps {
  anchorOffset?: number;
  anchorRef?: RefObject<HTMLElement | null>;
  topOffset?: number;
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | Window {
  let current = element.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);
    const scrollableY =
      style.overflowY === "auto" ||
      style.overflowY === "scroll" ||
      style.overflowY === "overlay";

    if (scrollableY && current.scrollHeight > current.clientHeight) {
      return current;
    }

    current = current.parentElement;
  }

  return window;
}

function scrollElementToTop(
  element: HTMLElement,
  topOffset: number,
  behavior: ScrollBehavior,
) {
  const scrollParent = findScrollableAncestor(element);

  if (scrollParent === window) {
    window.scrollTo({
      behavior,
      top: element.getBoundingClientRect().top + window.scrollY - topOffset,
    });
    return;
  }

  const container = scrollParent as HTMLElement;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  container.scrollTo({
    behavior,
    top: elementRect.top - containerRect.top + container.scrollTop - topOffset,
  });
}

function useStickyAnchorTop(
  anchorRef: RefObject<HTMLElement | null> | undefined,
  minTop: number,
  anchorOffset: number,
) {
  const [top, setTop] = useState(minTop);
  const rafId = useRef<number | null>(null);

  const update = useCallback(() => {
    const anchorTop = anchorRef?.current?.getBoundingClientRect().top;
    const nextTop =
      anchorTop === undefined
        ? minTop
        : Math.max(minTop, anchorTop + anchorOffset);

    setTop(Math.round(nextTop));
  }, [anchorOffset, anchorRef, minTop]);

  const scheduleUpdate = useCallback(() => {
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      update();
    });
  }, [update]);

  useEffect(() => {
    update();

    window.addEventListener("resize", scheduleUpdate);
    document.addEventListener("scroll", scheduleUpdate, {
      capture: true,
      passive: true,
    });

    const observer =
      anchorRef?.current && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleUpdate)
        : null;

    if (anchorRef?.current) {
      observer?.observe(anchorRef.current);
    }

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      document.removeEventListener("scroll", scheduleUpdate, {
        capture: true,
      });
      observer?.disconnect();
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [anchorRef, scheduleUpdate, update]);

  return top;
}

/**
 * Track which heading is currently visible by listening to scroll events
 * from the current document scroll container.
 */
function useScrollActiveHeading(
  headingList: { id: string; title: string; depth: number }[] | undefined,
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const rafId = useRef<number | null>(null);

  const update = useCallback(() => {
    if (!headingList || headingList.length === 0) return;

    let currentId: string | null = null;
    let bestTop = -Infinity;

    for (const heading of headingList) {
      const el =
        document.getElementById(heading.id) ||
        document.querySelector(`[data-block-id="${heading.id}"]`);
      if (!el) continue;

      const rect = el.getBoundingClientRect();
      // Last heading that's at or above the threshold (near top of viewport)
      if (rect.top <= 150 && rect.top > bestTop) {
        bestTop = rect.top;
        currentId = heading.id;
      }
    }

    if (!currentId && headingList.length > 0) {
      currentId = headingList[0].id;
    }

    setActiveId(currentId);
  }, [headingList]);

  const scheduleUpdate = useCallback(() => {
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      update();
    });
  }, [update]);

  useEffect(() => {
    if (!headingList || headingList.length === 0) return;

    update();

    // Use capture phase to catch scroll events from any container
    document.addEventListener("scroll", scheduleUpdate, {
      capture: true,
      passive: true,
    });

    return () => {
      document.removeEventListener("scroll", scheduleUpdate, { capture: true });
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [headingList, update, scheduleUpdate]);

  return activeId;
}

export function TocSidebar({
  anchorOffset = 12,
  anchorRef,
  topOffset = 80,
}: TocSidebarProps) {
  const state = useTocSideBarState({
    open: true,
    topOffset,
    rootMargin: "0px 0px 0px 0px",
  });

  const { editor, headingList, activeContentId: plateActiveId } = state;

  const { navProps, onContentClick } = useTocSideBar(state);

  const [isHovered, setIsHovered] = useState(false);
  const scrollActiveId = useScrollActiveHeading(headingList);
  const activeContentId = scrollActiveId || plateActiveId;
  const stickyTop = useStickyAnchorTop(anchorRef, topOffset, anchorOffset);

  const handleHeadingClick = useCallback(
    (
      event: MouseEvent<HTMLButtonElement>,
      item: Heading,
      behavior: ScrollBehavior,
    ) => {
      onContentClick(event, item, behavior);

      const node = NodeApi.get(editor, item.path);
      const element = node ? editor.api.toDOMNode(node) : null;
      if (element instanceof HTMLElement) {
        scrollElementToTop(element, topOffset, behavior);
      }
    },
    [editor, onContentClick, topOffset],
  );

  if (!headingList || headingList.length === 0) return null;

  return (
    <nav
      {...navProps}
      ref={navProps.ref as React.Ref<HTMLElement>}
      className="fixed right-6 z-10 w-auto"
      style={{ top: stickyTop }}
      onMouseEnter={() => {
        navProps.onMouseEnter();
        setIsHovered(true);
      }}
      onMouseLeave={(e) => {
        navProps.onMouseLeave(e);
        setIsHovered(false);
      }}
    >
      {/* Collapsed: bars */}
      {!isHovered && (
        <div className="flex flex-col gap-1 items-end pr-1">
          {headingList.map((item) => (
            <button
              key={item.id}
              className={cn(
                "h-0.5 rounded-full transition-colors cursor-pointer",
                item.id === activeContentId
                  ? "bg-foreground"
                  : "bg-muted-foreground/30",
                item.depth === 1 && "w-6",
                item.depth === 2 && "w-5",
                item.depth >= 3 && "w-4",
              )}
              onClick={(e) => handleHeadingClick(e, item, "smooth")}
            />
          ))}
        </div>
      )}

      {/* Expanded: heading list */}
      {isHovered && (
        <div className="bg-background/95 backdrop-blur-sm border rounded-md py-2 px-3 shadow-md max-w-[200px]">
          <div className="flex flex-col gap-0.5">
            {headingList.map((item) => (
              <button
                key={item.id}
                className={cn(
                  "text-left text-xs truncate py-0.5 hover:text-foreground transition-colors cursor-pointer",
                  item.id === activeContentId
                    ? "text-primary font-medium"
                    : "text-muted-foreground",
                  item.depth === 2 && "pl-3",
                  item.depth >= 3 && "pl-6",
                )}
                onClick={(e) => handleHeadingClick(e, item, "smooth")}
              >
                {item.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
