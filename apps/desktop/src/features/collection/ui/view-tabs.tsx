import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { FileText, MoreHorizontal, Plus, type LucideProps } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { CollectionView } from "@/features/collection/query";
import { viewType } from "../lib/utils";
import { viewIcons } from "./view-icons";
import type { ActiveTab } from "../model";

type TabIcon = ComponentType<LucideProps>;

interface CollectionTabItem {
  value: ActiveTab;
  label: string;
  Icon: TabIcon;
}

interface CollectionTabStripProps {
  activeTab: ActiveTab;
  addViewLabel: string;
  documentLabel: string;
  hasReadme: boolean;
  moreViewsLabel: string;
  views: CollectionView[];
  onAddView: () => void;
  onTabChange: (tab: ActiveTab) => void;
}

const OUTER_GAP = 8;
const TABS_LIST_PADDING = 6;

function setNextVisibleValues(
  setVisibleValues: (updater: (current: ActiveTab[]) => ActiveTab[]) => void,
  nextValues: ActiveTab[],
) {
  setVisibleValues((current) =>
    sameValues(current, nextValues) ? current : nextValues,
  );
}

export function CollectionTabStrip({
  activeTab,
  addViewLabel,
  documentLabel,
  hasReadme,
  moreViewsLabel,
  views,
  onAddView,
  onTabChange,
}: CollectionTabStripProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabMeasureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const addMeasureRef = useRef<HTMLDivElement | null>(null);
  const moreMeasureRef = useRef<HTMLDivElement | null>(null);
  const [visibleValues, setVisibleValues] = useState<ActiveTab[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);

  const tabs = useMemo<CollectionTabItem[]>(() => {
    const items = views.map((view) => ({
      value: view.name,
      label: view.name,
      Icon: viewIcons[viewType(view)],
    }));
    return hasReadme
      ? [
          {
            value: "document",
            label: documentLabel,
            Icon: FileText,
          },
          ...items,
        ]
      : items;
  }, [documentLabel, hasReadme, views]);

  const updateVisibleTabs = useCallback(() => {
    const container = containerRef.current;
    if (!container || tabs.length === 0) {
      setNextVisibleValues(setVisibleValues, []);
      return;
    }

    const tabWidths = tabs.map(
      (_, index) => tabMeasureRefs.current[index]?.offsetWidth ?? 0,
    );
    if (tabWidths.some((width) => width === 0)) {
      setNextVisibleValues(
        setVisibleValues,
        tabs.map((tab) => tab.value),
      );
      return;
    }

    const addWidth = addMeasureRef.current?.offsetWidth ?? 28;
    const moreWidth = moreMeasureRef.current?.offsetWidth ?? 28;
    const availableWithoutMore =
      container.clientWidth - addWidth - OUTER_GAP - TABS_LIST_PADDING;
    const totalTabsWidth = tabWidths.reduce((sum, width) => sum + width, 0);

    if (totalTabsWidth <= availableWithoutMore) {
      setNextVisibleValues(
        setVisibleValues,
        tabs.map((tab) => tab.value),
      );
      return;
    }

    const activeIndex = tabs.findIndex((tab) => tab.value === activeTab);
    const pinnedIndexes = new Set<number>();
    if (hasReadme) pinnedIndexes.add(0);
    if (activeIndex >= 0) pinnedIndexes.add(activeIndex);

    let remaining =
      container.clientWidth -
      addWidth -
      moreWidth -
      OUTER_GAP * 2 -
      TABS_LIST_PADDING;
    const visibleIndexes = new Set<number>();

    for (const index of [...pinnedIndexes].sort((a, b) => a - b)) {
      visibleIndexes.add(index);
      remaining -= tabWidths[index] ?? 0;
    }

    for (let index = 0; index < tabs.length; index += 1) {
      if (visibleIndexes.has(index)) continue;
      const width = tabWidths[index] ?? 0;
      if (width > remaining) continue;
      visibleIndexes.add(index);
      remaining -= width;
    }

    const nextValues = tabs
      .filter((_, index) => visibleIndexes.has(index))
      .map((tab) => tab.value);
    setNextVisibleValues(setVisibleValues, nextValues);
  }, [activeTab, hasReadme, tabs]);

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

  const visibleSet = new Set(
    visibleValues.length > 0 ? visibleValues : tabs.map((tab) => tab.value),
  );
  const visibleTabs = tabs.filter((tab) => visibleSet.has(tab.value));
  const overflowTabs = tabs.filter((tab) => !visibleSet.has(tab.value));

  return (
    <div
      ref={containerRef}
      className="relative flex min-w-0 flex-1 items-center gap-2"
    >
      <TabsList className="min-w-0 max-w-full flex-nowrap overflow-hidden">
        {visibleTabs.map((tab) => (
          <CollectionViewTab key={tab.value} tab={tab} />
        ))}
      </TabsList>
      {overflowTabs.length > 0 ? (
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={moreViewsLabel}
              className="shrink-0 rounded-md text-muted-foreground hover:text-foreground"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1">
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                onTabChange(value);
                setMoreOpen(false);
              }}
              orientation="vertical"
              className="gap-0"
            >
              <TabsList className="w-full items-stretch bg-transparent p-0">
                {overflowTabs.map((tab) => (
                  <CollectionViewTab key={tab.value} tab={tab} />
                ))}
              </TabsList>
            </Tabs>
          </PopoverContent>
        </Popover>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            onClick={onAddView}
          >
            <Plus />
            <span className="sr-only">{addViewLabel}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{addViewLabel}</TooltipContent>
      </Tooltip>
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
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <tab.Icon />
            {tab.label}
          </div>
        ))}
        <div ref={moreMeasureRef} className="size-7" />
        <div ref={addMeasureRef} className="size-7" />
      </div>
    </div>
  );
}

function CollectionViewTab({ tab }: { tab: CollectionTabItem }) {
  return (
    <TabsTrigger value={tab.value} data-collection-tab={tab.value}>
      <tab.Icon />
      {tab.label}
    </TabsTrigger>
  );
}

function sameValues(first: ActiveTab[], second: ActiveTab[]) {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}
