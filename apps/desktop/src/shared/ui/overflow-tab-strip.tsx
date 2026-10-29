import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";

export interface OverflowTab<Value extends string = string> {
  value: Value;
  label: string;
  icon: ReactNode;
}

interface OverflowTabStripProps<Value extends string> {
  tabs: readonly OverflowTab<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  /**
   * A tab chosen by a click, Enter or Space, the active one included, as
   * `onValueChange` reports only a change.
   */
  onTabChoose?: (value: Value) => void;
  moreLabel: string;
  /** Accessible name of the tab list. */
  listLabel?: string;
  /**
   * Only the active tab shows its label; another tab shows its icon and
   * names itself in a tooltip.
   */
  labelActiveOnly?: boolean;
  /** Activation of the tabs listed under the overflow control. */
  overflowActivationMode?: "automatic" | "manual";
  /** Content after the tabs, such as an add button. */
  trailing?: ReactNode;
  /** Width the tabs leave free for `trailing`. */
  trailingWidth?: number;
  className?: string;
}

const OUTER_GAP = 8;
const TABS_LIST_PADDING = 6;
const ACTIVE_DROPDOWN_EXTRA_WIDTH = 22;
const tabShapeClassName =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const overflowTriggerClassName =
  "relative inline-flex h-[calc(100%-1px)] shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

interface TabStripLayout {
  visibleCount: number;
  activeAsDropdown: boolean;
  hasOverflow: boolean;
}

const defaultLayout: TabStripLayout = {
  visibleCount: 0,
  activeAsDropdown: false,
  hasOverflow: false,
};

/**
 * One row of tabs inside a `Tabs` root of the caller. Tabs that do not fit
 * move under a "more" control at the end; when the active tab is among
 * them, it takes the place of that control. The list of those tabs opens
 * in a popover of its own, so a container that clips does not cut it.
 */
export function OverflowTabStrip<Value extends string>({
  tabs,
  value,
  onValueChange,
  onTabChoose,
  moreLabel,
  listLabel,
  labelActiveOnly = false,
  overflowActivationMode,
  trailing,
  trailingWidth = 0,
  className,
}: OverflowTabStripProps<Value>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabMeasureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const moreMeasureRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<TabStripLayout>(defaultLayout);
  const [moreOpen, setMoreOpen] = useState(false);

  const showsLabel = useCallback(
    (tab: OverflowTab<Value>) => !labelActiveOnly || tab.value === value,
    [labelActiveOnly, value],
  );

  const hasTrailing = trailing != null;

  const chooseInOverflow = onTabChoose
    ? (next: Value) => {
        setMoreOpen(false);
        onTabChoose(next);
      }
    : undefined;

  const updateVisibleTabs = useCallback(() => {
    const container = containerRef.current;
    if (!container || tabs.length === 0) {
      setNextLayout(setLayout, defaultLayout);
      return;
    }

    const tabWidths = tabs.map(
      (_, index) => tabMeasureRefs.current[index]?.offsetWidth ?? 0,
    );
    if (tabWidths.some((width) => width === 0)) {
      setNextLayout(setLayout, {
        visibleCount: tabs.length,
        activeAsDropdown: false,
        hasOverflow: false,
      });
      return;
    }

    const moreWidth = moreMeasureRef.current?.offsetWidth ?? 28;
    const totalTabsWidth = tabWidths.reduce((sum, width) => sum + width, 0);
    const availableWithoutOverflow =
      container.clientWidth -
      (hasTrailing ? trailingWidth + OUTER_GAP : 0) -
      TABS_LIST_PADDING;

    if (totalTabsWidth <= availableWithoutOverflow) {
      setNextLayout(setLayout, {
        visibleCount: tabs.length,
        activeAsDropdown: false,
        hasOverflow: false,
      });
      return;
    }

    const activeIndex = tabs.findIndex((tab) => tab.value === value);
    const prefixWithMoreCount = countFittingPrefix(
      tabWidths,
      availableWithoutOverflow - moreWidth,
    );

    if (activeIndex >= 0 && activeIndex < prefixWithMoreCount) {
      setNextLayout(setLayout, {
        visibleCount: prefixWithMoreCount,
        activeAsDropdown: false,
        hasOverflow: true,
      });
      return;
    }

    const activeWidth =
      activeIndex >= 0
        ? (tabWidths[activeIndex] ?? 0) + ACTIVE_DROPDOWN_EXTRA_WIDTH
        : 0;
    const visibleCount = countFittingPrefix(
      tabWidths.slice(0, Math.max(activeIndex, 0)),
      availableWithoutOverflow - activeWidth,
    );
    setNextLayout(setLayout, {
      visibleCount,
      activeAsDropdown: activeIndex >= 0,
      hasOverflow: true,
    });
  }, [hasTrailing, tabs, trailingWidth, value]);

  useLayoutEffect(() => {
    updateVisibleTabs();
  }, [updateVisibleTabs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVisibleTabs);
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateVisibleTabs]);

  const activeTab = tabs.find((tab) => tab.value === value) ?? null;
  const visibleTabs = tabs.slice(0, layout.visibleCount);
  const hiddenTabs = tabs.slice(layout.visibleCount);
  const shouldShowOverflowControl = layout.hasOverflow && tabs.length > 0;

  return (
    <div
      ref={containerRef}
      className="relative flex min-w-0 flex-1 items-center gap-2"
    >
      <TabsList
        aria-label={listLabel}
        className={cn(
          "min-w-0 max-w-full flex-nowrap overflow-hidden",
          className,
        )}
      >
        {visibleTabs.map((tab) => (
          <StripTab
            key={tab.value}
            tab={tab}
            label={showsLabel(tab)}
            onChoose={onTabChoose}
          />
        ))}
        {shouldShowOverflowControl ? (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              {layout.activeAsDropdown && activeTab ? (
                <button
                  type="button"
                  className={cn(
                    overflowTriggerClassName,
                    "bg-background text-foreground shadow-sm",
                  )}
                >
                  {activeTab.icon}
                  {activeTab.label}
                  <ChevronDown />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={moreLabel}
                  className={overflowTriggerClassName}
                >
                  <MoreHorizontal />
                </button>
              )}
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={4}
              className="w-56 gap-0 rounded-xl bg-muted p-[3px] text-muted-foreground"
            >
              <Tabs
                value={value}
                onValueChange={(next) => {
                  onValueChange(next as Value);
                  setMoreOpen(false);
                }}
                orientation="vertical"
                activationMode={overflowActivationMode}
                className="gap-0"
              >
                <TabsList className="h-auto w-full items-stretch rounded-lg bg-transparent p-0">
                  {hiddenTabs.map((tab) => (
                    <TabsTrigger
                      key={tab.value}
                      value={tab.value}
                      className="h-8 justify-start px-2.5"
                      {...chooseHandlers(tab.value, chooseInOverflow)}
                    >
                      {tab.icon}
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </PopoverContent>
          </Popover>
        ) : null}
      </TabsList>
      {trailing}
      <div
        aria-hidden
        className="pointer-events-none fixed -left-[10000px] top-0 flex opacity-0"
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.value}
            ref={(node) => {
              tabMeasureRefs.current[index] = node;
            }}
            className={tabShapeClassName}
          >
            {tab.icon}
            {showsLabel(tab) ? tab.label : null}
          </div>
        ))}
        <div ref={moreMeasureRef} className={tabShapeClassName}>
          <MoreHorizontal />
        </div>
      </div>
    </div>
  );
}

function StripTab<Value extends string>({
  tab,
  label,
  onChoose,
}: {
  tab: OverflowTab<Value>;
  label: boolean;
  onChoose?: (value: Value) => void;
}) {
  const handlers = chooseHandlers(tab.value, onChoose);
  if (label) {
    return (
      <TabsTrigger value={tab.value} {...handlers}>
        {tab.icon}
        {tab.label}
      </TabsTrigger>
    );
  }
  // The tooltip trigger is a wrapper: on the tab itself its own `data-state`
  // would replace the active state of the tab.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-full">
          <TabsTrigger value={tab.value} aria-label={tab.label} {...handlers}>
            {tab.icon}
          </TabsTrigger>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tab.label}</TooltipContent>
    </Tooltip>
  );
}

/** A tab's choice on the press that activates a tab of the `Tabs` primitive. */
function chooseHandlers<Value extends string>(
  value: Value,
  onChoose: ((value: Value) => void) | undefined,
) {
  if (!onChoose) return {};
  return {
    onMouseDown: (event: MouseEvent) => {
      if (event.button === 0 && !event.ctrlKey) onChoose(value);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") onChoose(value);
    },
  };
}

function setNextLayout(
  setLayout: (updater: (current: TabStripLayout) => TabStripLayout) => void,
  nextLayout: TabStripLayout,
) {
  setLayout((current) =>
    sameLayout(current, nextLayout) ? current : nextLayout,
  );
}

function countFittingPrefix(widths: number[], availableWidth: number) {
  let usedWidth = 0;
  let count = 0;
  for (const width of widths) {
    if (usedWidth + width > availableWidth) break;
    usedWidth += width;
    count += 1;
  }
  return count;
}

function sameLayout(first: TabStripLayout, second: TabStripLayout) {
  return (
    first.visibleCount === second.visibleCount &&
    first.activeAsDropdown === second.activeAsDropdown &&
    first.hasOverflow === second.hasOverflow
  );
}
