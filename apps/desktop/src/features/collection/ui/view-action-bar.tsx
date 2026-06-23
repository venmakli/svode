import { ArrowUpDown, Filter, Group } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { UseViewQueryResult, ViewType } from "@/features/collection/query/model";
import type { CollectionView } from "@/features/collection/query/model";
import type { CollectionSchema } from "@/features/properties";
import { SearchControl } from "./search-control";
import type { SettingsPane } from "../model";
import type { TemplateInfo, TemplateKind } from "../model";
import { TemplatesSplitButton } from "./templates-menu";
import { ViewSettingsPopover } from "./view-settings-popover";
import * as m from "@/paraglide/messages.js";

const toolbarIconButtonClass =
  "rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground";
const toolbarActiveButtonClass =
  "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground";
const toolbarBadgeButtonClass = "h-7 gap-1 rounded-[7px] px-2";
const toolbarCountBadgeClass =
  "h-3.5 min-w-3.5 rounded-full px-1 text-[10px] leading-none";
const toolbarPillButtonClass =
  "h-7 max-w-40 rounded-[7px] bg-foreground/[0.03] px-[9px] text-muted-foreground shadow-none hover:bg-accent hover:text-foreground";

export function ViewActionBar({
  searchOpen,
  searchQuery,
  settingsOpen,
  settingsPane,
  activeView,
  renameValue,
  schema,
  query,
  collectionPath,
  spacePath,
  projectPath,
  onSearchOpenChange,
  onSearchQueryChange,
  onSettingsOpenChange,
  onSettingsPaneChange,
  onRenameValueChange,
  onRename,
  onUpdateView,
  onDuplicateView,
  onDeleteViewRequest,
  onSchemaChange,
  autoConfigForType,
  onCreateEntry,
  onLoadTemplates,
  onCreateTemplate,
  onInstantiateTemplate,
  onEditTemplate,
  onSetDefaultTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  onReorderTemplates,
}: {
  searchOpen: boolean;
  searchQuery: string;
  settingsOpen: boolean;
  settingsPane: SettingsPane;
  activeView: CollectionView | null;
  renameValue: string;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  onSearchOpenChange: (open: boolean) => void;
  onSearchQueryChange: (query: string) => void;
  onSettingsOpenChange: (open: boolean) => void;
  onSettingsPaneChange: (pane: SettingsPane) => void;
  onRenameValueChange: (value: string) => void;
  onRename: () => Promise<void>;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onDuplicateView: () => Promise<void>;
  onDeleteViewRequest: () => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  autoConfigForType: (type: ViewType) => Record<string, unknown>;
  onCreateEntry: (asFolder: boolean) => void;
  onLoadTemplates: () => Promise<TemplateInfo[]>;
  onCreateTemplate: (kind: TemplateKind) => Promise<void>;
  onInstantiateTemplate: (
    template: TemplateInfo,
    forceFolder: boolean,
  ) => Promise<void>;
  onEditTemplate: (template: TemplateInfo) => Promise<void>;
  onSetDefaultTemplate: (slug: string | null) => Promise<void>;
  onDuplicateTemplate: (template: TemplateInfo) => Promise<void>;
  onDeleteTemplate: (template: TemplateInfo) => Promise<void>;
  onReorderTemplates: (slugs: string[]) => Promise<void>;
}) {
  const filterActive =
    settingsOpen &&
    (settingsPane === "filter" ||
      settingsPane === "filterField" ||
      settingsPane === "filterEditor");
  const sortActive =
    settingsOpen &&
    (settingsPane === "sort" ||
      settingsPane === "sortField" ||
      settingsPane === "sortEditor");
  const groupActive = settingsOpen && settingsPane === "group";
  const filterCount = query.merged.filter.length;
  const sortCount = query.merged.sort.length;
  const groupBy =
    activeView?.type === "board"
      ? (query.merged.groupBy ?? undefined)
      : undefined;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <SearchControl
        open={searchOpen}
        query={searchQuery}
        onOpenChange={onSearchOpenChange}
        onQueryChange={onSearchQueryChange}
      />
      {activeView?.type === "board" && groupBy ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            toolbarPillButtonClass,
            groupActive && toolbarActiveButtonClass,
          )}
          aria-label={`${m.view_query_group_title()}: ${groupBy}`}
          onClick={() => {
            onSettingsPaneChange("group");
            onSettingsOpenChange(true);
          }}
        >
          <Group className="size-[13px]" data-icon="inline-start" />
          <span className="truncate">{groupBy}</span>
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={filterCount > 0 ? "sm" : "icon-sm"}
            className={cn(
              toolbarIconButtonClass,
              filterCount > 0 && toolbarBadgeButtonClass,
              (filterCount > 0 || filterActive) && toolbarActiveButtonClass,
            )}
            onClick={() => {
              onSettingsPaneChange("filter");
              onSettingsOpenChange(!filterActive);
            }}
          >
            <Filter />
            <span className="sr-only">{m.view_query_filter_title()}</span>
            {filterCount > 0 ? (
              <Badge className={toolbarCountBadgeClass}>{filterCount}</Badge>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{m.view_query_filter_title()}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={sortCount > 0 ? "sm" : "icon-sm"}
            className={cn(
              toolbarIconButtonClass,
              sortCount > 0 && toolbarBadgeButtonClass,
              (sortCount > 0 || sortActive) && toolbarActiveButtonClass,
            )}
            onClick={() => {
              onSettingsPaneChange("sort");
              onSettingsOpenChange(!sortActive);
            }}
          >
            <ArrowUpDown />
            <span className="sr-only">{m.view_query_sort_title()}</span>
            {sortCount > 0 ? (
              <Badge className={toolbarCountBadgeClass}>{sortCount}</Badge>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{m.view_query_sort_title()}</TooltipContent>
      </Tooltip>
      <ViewSettingsPopover
        open={settingsOpen}
        pane={settingsPane}
        view={activeView}
        renameValue={renameValue}
        onOpenChange={onSettingsOpenChange}
        onPaneChange={onSettingsPaneChange}
        onRenameValueChange={onRenameValueChange}
        onRename={onRename}
        onUpdateView={onUpdateView}
        onDuplicate={onDuplicateView}
        onDeleteRequest={onDeleteViewRequest}
        schema={schema}
        query={query}
        collectionPath={collectionPath}
        spacePath={spacePath}
        projectPath={projectPath}
        onSchemaChange={onSchemaChange}
        autoConfigForType={autoConfigForType}
      />
      <TemplatesSplitButton
        schema={schema}
        onPrimaryCreate={onCreateEntry}
        onLoadTemplates={onLoadTemplates}
        onCreateTemplate={onCreateTemplate}
        onInstantiateTemplate={onInstantiateTemplate}
        onEditTemplate={onEditTemplate}
        onSetDefaultTemplate={onSetDefaultTemplate}
        onDuplicateTemplate={onDuplicateTemplate}
        onDeleteTemplate={onDeleteTemplate}
        onReorderTemplates={onReorderTemplates}
      />
    </div>
  );
}
