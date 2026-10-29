import { useEffect, useMemo, useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { MultiPanePopover } from "@/shared/ui/multi-pane-popover";
import {
  OverflowTabStrip,
  type OverflowTab,
} from "@/shared/ui/overflow-tab-strip";
import type {
  CollectionView,
  ViewType,
} from "@/features/collection/query/model";
import { SettingsRow, SettingsSection } from "@/shared/ui/settings-row";
import { ManageViewsPane } from "./manage-views-pane";
import { viewType } from "../lib/utils";
import { viewIcons } from "./view-icons";
import type { ActiveTab } from "../model";

interface CollectionTabStripProps {
  activeTab: ActiveTab;
  addViewOptions: AddViewOption[];
  addViewLabel: string;
  manageViewsLabel: string;
  moreViewsLabel: string;
  readOnly: boolean;
  views: CollectionView[];
  onAddView: (type: ViewType) => void;
  onReorderViews: (nextOrder: string[]) => Promise<void>;
  onTabChange: (tab: ActiveTab) => void;
}

interface AddViewOption {
  label: string;
  type: ViewType;
}

/** Width kept for the add button, also while it is hidden in read-only. */
const ADD_BUTTON_WIDTH = 28;

type AddViewsPane = "add" | "manage";

export function CollectionTabStrip({
  activeTab,
  addViewOptions,
  addViewLabel,
  manageViewsLabel,
  moreViewsLabel,
  readOnly,
  views,
  onAddView,
  onReorderViews,
  onTabChange,
}: CollectionTabStripProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPane, setAddMenuPane] = useState<AddViewsPane>("add");

  const tabs = useMemo<OverflowTab<ActiveTab>[]>(
    () =>
      views.map((view) => {
        const Icon = viewIcons[viewType(view)];
        return { value: view.name, label: view.name, icon: <Icon /> };
      }),
    [views],
  );

  useEffect(() => {
    if (readOnly) queueMicrotask(() => setAddMenuOpen(false));
  }, [readOnly]);

  return (
    <OverflowTabStrip
      tabs={tabs}
      value={activeTab}
      onValueChange={onTabChange}
      moreLabel={moreViewsLabel}
      trailingWidth={ADD_BUTTON_WIDTH}
      trailing={
        !readOnly ? (
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
                    activeViewName={activeTab || null}
                    views={views}
                    onReorderViews={onReorderViews}
                    onSelectView={onTabChange}
                  />
                ),
              },
            ]}
          />
        ) : null
      }
    />
  );
}
