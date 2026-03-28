import { useRef, useState } from "react";
import {
  useTocSideBarState,
  useTocSideBar,
} from "@platejs/toc/react";
import { cn } from "@/lib/utils";

interface TocSidebarProps {
  topOffset?: number;
}

export function TocSidebar({ topOffset = 80 }: TocSidebarProps) {
  const state = useTocSideBarState({
    open: true,
    topOffset,
    rootMargin: "0px 0px 0px 0px",
  });

  const {
    headingList,
    activeContentId,
  } = state;

  const { navProps, onContentClick } = useTocSideBar(state);

  const [isHovered, setIsHovered] = useState(false);

  if (!headingList || headingList.length === 0) return null;

  return (
    <nav
      {...navProps}
      ref={navProps.ref as React.Ref<HTMLElement>}
      className="fixed right-2 top-[120px] z-10 w-auto"
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
              onClick={(e) => onContentClick(e, item, "smooth")}
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
                onClick={(e) => onContentClick(e, item, "smooth")}
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
