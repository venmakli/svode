import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  ChevronDown,
  FileText,
  GripVertical,
  MoreHorizontal,
  Plus,
  type LucideProps,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/shared/lib/utils";
import {
  MultiPanePopover,
  type CollectionView,
  type ViewType,
} from "@/features/collection/query";
import { SettingsRow, SettingsSection } from "./settings-row";
import { ManageViewsPane } from "./manage-views-pane";
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
  addViewOptions: AddViewOption[];
  addViewLabel: string;
  documentLabel: string;
  hasReadme: boolean;
  manageViewsLabel: string;
  moreViewsLabel: string;
  views: CollectionView[];
  onAddView: (type: ViewType) => void;
  onReorderViews: (nextOrder: string[]) => Promise<void>;
  onTabChange: (tab: ActiveTab) => void;
}

interface AddViewOption {
  label: string;
  type: ViewType;
}

const OUTER_GAP = 8;
const TABS_LIST_PADDING = 6;
const ACTIVE_DROPDOWN_EXTRA_WIDTH = 22;
const OVERFLOW_PANEL_WIDTH = 224;
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

type AddViewsPane = "add" | "manage";

function setNextLayout(
  setLayout: (updater: (current: TabStripLayout) => TabStripLayout) => void,
  nextLayout: TabStripLayout,
) {
  setLayout((current) => (sameLayout(current, nextLayout) ? current : nextLayout));
}

export function CollectionTabStrip({
  activeTab,
  addViewOptions,
  addViewLabel,
  documentLabel,
  hasReadme,
  manageViewsLabel,
  moreViewsLabel,
  views,
  onAddView,
  onReorderViews,
  onTabChange,
}: CollectionTabStripProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabMeasureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const addMeasureRef = useRef<HTMLDivElement | null>(null);
  const moreMeasureRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<TabStripLayout>(defaultLayout);
  const [moreOpen, setMoreOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPane, setAddMenuPane] = useState<AddViewsPane>("add");
  const [panelLeft, setPanelLeft] = useState(0);

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

    const addWidth = addMeasureRef.current?.offsetWidth ?? 28;
    const moreWidth = moreMeasureRef.current?.offsetWidth ?? 28;
    const totalTabsWidth = tabWidths.reduce((sum, width) => sum + width, 0);
    const availableWithoutOverflow =
      container.clientWidth - addWidth - OUTER_GAP - TABS_LIST_PADDING;

    if (totalTabsWidth <= availableWithoutOverflow) {
      setNextLayout(setLayout, {
        visibleCount: tabs.length,
        activeAsDropdown: false,
        hasOverflow: false,
      });
      return;
    }

    const activeIndex = tabs.findIndex((tab) => tab.value === activeTab);
    const prefixWithMoreWidth = availableWithoutOverflow - moreWidth;
    const prefixWithMoreCount = countFittingPrefix(tabWidths, prefixWithMoreWidth);

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
    const prefixWithActiveWidth = availableWithoutOverflow - activeWidth;
    const visibleCount = countFittingPrefix(
      tabWidths.slice(0, Math.max(activeIndex, 0)),
      prefixWithActiveWidth,
    );
    setNextLayout(setLayout, {
      visibleCount,
      activeAsDropdown: activeIndex >= 0,
      hasOverflow: true,
    });
  }, [activeTab, tabs]);

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

  useEffect(() => {
    if (!moreOpen) return;
    function handleDocumentMouseDown(event: MouseEvent) {
      const container = containerRef.current;
      if (!container || !(event.target instanceof Node)) return;
      if (container.contains(event.target)) return;
      setMoreOpen(false);
    }
    document.addEventListener("mousedown", handleDocumentMouseDown, true);
    return () =>
      document.removeEventListener("mousedown", handleDocumentMouseDown, true);
  }, [moreOpen]);

  const activeTabItem = tabs.find((tab) => tab.value === activeTab) ?? null;
  const visibleTabs = tabs.slice(0, layout.visibleCount);
  const hiddenTabs = tabs.slice(layout.visibleCount);
  const shouldShowOverflowControl = layout.hasOverflow && tabs.length > 0;

  const toggleOverflowPanel = useCallback(
    (trigger: HTMLElement) => {
      const container = containerRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const maxLeft = Math.max(0, containerRect.width - OVERFLOW_PANEL_WIDTH);
        const nextLeft = Math.max(
          0,
          Math.min(triggerRect.left - containerRect.left, maxLeft),
        );
        setPanelLeft(nextLeft);
      }
      setMoreOpen((open) => {
        return !open;
      });
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative flex min-w-0 flex-1 items-center gap-2"
    >
      <TabsList className="min-w-0 max-w-full flex-nowrap overflow-hidden">
        {visibleTabs.map((tab) => (
          <CollectionViewTab key={tab.value} tab={tab} />
        ))}
        {layout.activeAsDropdown && activeTabItem ? (
          <ActiveDropdownTabButton
            tab={activeTabItem}
            open={moreOpen}
            onToggle={toggleOverflowPanel}
          />
        ) : shouldShowOverflowControl ? (
          <button
            type="button"
            aria-label={moreViewsLabel}
            className={overflowTriggerClassName}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleOverflowPanel(event.currentTarget);
            }}
          >
            <MoreHorizontal />
          </button>
        ) : null}
      </TabsList>
      {moreOpen ? (
        <div
          className="absolute top-[calc(100%+4px)] z-50 w-56 rounded-xl bg-muted p-[3px] text-muted-foreground shadow-md ring-1 ring-foreground/10"
          style={{ left: panelLeft }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <OverflowTabs
            activeTab={activeTab}
            tabs={hiddenTabs}
            onSelect={(value) => {
              onTabChange(value);
              setMoreOpen(false);
            }}
          />
        </div>
      ) : null}
      <MultiPanePopover<AddViewsPane>
        open={addMenuOpen}
        onOpenChange={(open) => {
          setAddMenuOpen(open);
          if (open) setAddMenuPane("add");
        }}
        pane={addMenuPane}
        onPaneChange={setAddMenuPane}
        mainPane="add"
        align="start"
        className="w-72"
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          >
            <Plus />
            <span className="sr-only">{addViewLabel}</span>
          </Button>
        }
        panes={[
          {
            id: "add",
            title: addViewLabel,
            content: (
              <div className="flex flex-col p-1">
                <SettingsSection label={addViewLabel} />
                {addViewOptions.map((option) => {
                  const Icon = viewIcons[option.type];
                  return (
                    <SettingsRow
                      key={option.type}
                      icon={Icon}
                      label={option.label}
                      right={null}
                      onClick={() => {
                        onAddView(option.type);
                        setAddMenuOpen(false);
                      }}
                    />
                  );
                })}
                <Separator className="my-1" />
                <SettingsRow
                  icon={GripVertical}
                  label={manageViewsLabel}
                  onClick={() => setAddMenuPane("manage")}
                />
              </div>
            ),
          },
          {
            id: "manage",
            title: manageViewsLabel,
            content: (
              <ManageViewsPane
                activeViewName={activeTab === "document" ? null : activeTab}
                views={views}
                onReorderViews={onReorderViews}
                onSelectView={onTabChange}
              />
            ),
          },
        ]}
      />
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
        <div
          ref={moreMeasureRef}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
        >
          <MoreHorizontal />
        </div>
        <div ref={addMeasureRef} className="size-7" />
      </div>
    </div>
  );
}

function CollectionViewTab({
  tab,
  className,
}: {
  tab: CollectionTabItem;
  className?: string;
}) {
  return (
    <TabsTrigger
      value={tab.value}
      data-collection-tab={tab.value}
      className={className}
    >
      <tab.Icon />
      {tab.label}
    </TabsTrigger>
  );
}

function ActiveDropdownTabButton({
  tab,
  open,
  onToggle,
}: {
  tab: CollectionTabItem;
  open: boolean;
  onToggle: (trigger: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      data-collection-tab={tab.value}
      className={cn(
        overflowTriggerClassName,
        "bg-background text-foreground shadow-sm",
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(event.currentTarget);
      }}
    >
      <tab.Icon />
      {tab.label}
      <ChevronDown />
    </button>
  );
}

function OverflowTabs({
  activeTab,
  tabs,
  onSelect,
}: {
  activeTab: ActiveTab;
  tabs: CollectionTabItem[];
  onSelect: (value: ActiveTab) => void;
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={onSelect}
      orientation="vertical"
      className="gap-0"
    >
      <TabsList className="h-auto w-full items-stretch rounded-lg bg-transparent p-0">
        {tabs.map((tab) => (
          <CollectionViewTab
            key={tab.value}
            tab={tab}
            className="h-8 justify-start px-2.5"
          />
        ))}
      </TabsList>
    </Tabs>
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
