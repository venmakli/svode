import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

/** Tools collapse once the space given to them is narrower than they are. */
export function shouldCollapseViewTools(
  available: number | null,
  natural: number | null,
) {
  if (available === null || natural === null) return false;
  return available + 0.5 < natural;
}

/**
 * The flexible middle of a top bar: view tools pushed to its end, collapsed
 * into one popover button when the row cannot fit them. Its flex basis stays
 * the natural width of the tools in both states, so the row layout does not
 * change when it collapses; neighbours that should shrink first need a higher
 * flex-shrink.
 */
export function ViewToolsGroup({ children }: { children: ReactNode }) {
  const groupRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const collapsed = shouldCollapseViewTools(available, natural);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => setAvailable(group.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  // The inline tools are measured while shown; collapsed keeps the last width.
  useLayoutEffect(() => {
    const tools = toolsRef.current;
    if (collapsed || !tools) return;
    const measure = () => setNatural(tools.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(tools);
    return () => observer.disconnect();
  }, [collapsed]);

  return (
    <div
      ref={groupRef}
      data-view-tools={collapsed ? "collapsed" : "inline"}
      className="flex min-w-0 flex-1 items-center justify-end"
      style={natural === null ? undefined : { flexBasis: natural }}
    >
      {collapsed ? (
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.view_tools()}
                >
                  <SlidersHorizontal />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{m.view_tools()}</TooltipContent>
          </Tooltip>
          <PopoverContent
            align="end"
            className="w-auto max-w-[calc(100vw-2rem)] flex-row flex-wrap items-center gap-1 p-1.5"
          >
            {children}
          </PopoverContent>
        </Popover>
      ) : (
        <div ref={toolsRef} className="flex w-max shrink-0 items-center gap-1">
          {children}
        </div>
      )}
    </div>
  );
}
