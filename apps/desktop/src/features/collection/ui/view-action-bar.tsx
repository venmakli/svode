import { ArrowUpDown, ChevronDown, Columns3, Filter, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  UseViewQueryResult,
  ViewType,
} from "@/features/collection/query";
import type { CollectionView } from "@/features/collection/query";
import type { CollectionSchema } from "@/features/properties/model";
import { SearchControl } from "./search-control";
import type { SettingsPane } from "../model";
import { ViewSettingsPopover } from "./view-settings-popover";
import * as m from "@/paraglide/messages.js";

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
          variant="outline"
          size="sm"
          className="max-w-40 truncate"
          onClick={() => {
            onSettingsPaneChange("group");
            onSettingsOpenChange(true);
          }}
        >
          <Columns3 data-icon="inline-start" />
          <span className="truncate">
            {m.view_query_group_title()}: {groupBy}
          </span>
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn(
              (query.merged.filter.length > 0 || filterActive) && "relative",
              filterActive && "bg-accent text-accent-foreground",
            )}
            onClick={() => {
              onSettingsPaneChange("filter");
              onSettingsOpenChange(!filterActive);
            }}
          >
            <Filter />
            <span className="sr-only">{m.view_query_filter_title()}</span>
            {query.merged.filter.length > 0 ? (
              <Badge className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px]">
                {query.merged.filter.length}
              </Badge>
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
            size="icon-sm"
            className={cn(
              (query.merged.sort.length > 0 || sortActive) && "relative",
              sortActive && "bg-accent text-accent-foreground",
            )}
            onClick={() => {
              onSettingsPaneChange("sort");
              onSettingsOpenChange(!sortActive);
            }}
          >
            <ArrowUpDown />
            <span className="sr-only">{m.view_query_sort_title()}</span>
            {query.merged.sort.length > 0 ? (
              <Badge className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px]">
                {query.merged.sort.length}
              </Badge>
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
      <ButtonGroup>
        <Button
          type="button"
          size="sm"
          onClick={(event) => onCreateEntry(event.shiftKey)}
        >
          <Plus data-icon="inline-start" />
          {m.collection_new_entry()}
        </Button>
        <ButtonGroupSeparator />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              aria-label={m.collection_templates()}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{m.collection_templates()}</DropdownMenuLabel>
              <DropdownMenuItem disabled>
                {m.collection_view_composer_pending()}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <Plus />
              {m.collection_new_template()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
    </div>
  );
}
