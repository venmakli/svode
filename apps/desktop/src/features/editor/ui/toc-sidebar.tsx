import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type MouseEvent,
  type Ref,
} from "react";
import { NodeApi } from "platejs";
import type { Heading } from "@platejs/toc";
import { useTocSideBarState, useTocSideBar } from "@platejs/toc/react";
import { cn } from "@/shared/lib/utils";

interface TocSidebarProps {
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

    queueMicrotask(() => setActiveId(currentId));
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

    scheduleUpdate();

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
  }, [headingList, scheduleUpdate]);

  return activeId;
}

export function TocSidebar({ topOffset = 80 }: TocSidebarProps) {
  const state = useTocSideBarState({
    open: true,
    topOffset,
    rootMargin: "0px 0px 0px 0px",
  });

  const { editor, headingList, activeContentId: plateActiveId } = state;

  const { navProps, onContentClick } = useTocSideBar(state);
  const {
    ref: navRef,
    onMouseEnter: onNavMouseEnter,
    onMouseLeave: onNavMouseLeave,
    ...restNavProps
  } = navProps;

  const [isHovered, setIsHovered] = useState(false);
  const scrollActiveId = useScrollActiveHeading(headingList);
  const activeContentId = scrollActiveId || plateActiveId;

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
    <div className="pointer-events-none absolute bottom-0 right-2 top-12 z-10 w-auto">
      <nav
        {...restNavProps}
        ref={navRef as Ref<HTMLElement>}
        className="pointer-events-auto sticky top-12 w-auto"
        onMouseEnter={() => {
          onNavMouseEnter();
          setIsHovered(true);
        }}
        onMouseLeave={(e) => {
          onNavMouseLeave(e);
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
    </div>
  );
}
