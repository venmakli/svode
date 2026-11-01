import type { EventContentArg } from "@fullcalendar/core";
import { Database, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Page } from "@/features/page";
import { pageNameConflictDisplayPath } from "@/features/page/page-api";
import { validatePropertyValue, type Column } from "@/features/properties";
import { PropertyControl } from "@/features/properties/control";
import { PropertyValue } from "@/features/properties/display";
import { cn } from "@/shared/lib/utils";
import { eventColorStyle } from "../../hooks/calendar/calendar-adapter";
import type {
  CalendarEventModel,
  CalendarPropertyContext,
  CalendarScope,
} from "../../model/calendar-types";
import { CollectionItemContextMenuItems } from "../item-context-menu";
import { PageTitleIcon } from "../page-title-icon";
import * as m from "@/paraglide/messages.js";

export function CalendarEventContent({
  readOnly,
  arg,
  scope,
  onOpen,
  onOpenNestedPeek,
  onOpenNestedCollection,
  propertyContext,
}: {
  readOnly: boolean;
  arg: EventContentArg;
  scope: CalendarScope;
  onOpen: (item: Page) => void;
  onOpenNestedPeek: (item: Page) => void;
  onOpenNestedCollection: (item: Page) => void;
  propertyContext: CalendarPropertyContext;
}) {
  const model = arg.event.extendedProps.model as CalendarEventModel | undefined;
  if (!model) return null;
  const { item } = model;
  const conflictPath = pageNameConflictDisplayPath(item);
  const list = scope === "list";
  const compact = scope === "week" || scope === "day";

  function openItem() {
    if (model?.nestedCollection) onOpenNestedPeek(item);
    else onOpen(item);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "svode-calendar-event-content group/calendar-event flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] leading-5 ring-1 ring-transparent",
            "bg-(--calendar-event-soft) text-foreground hover:ring-(--calendar-event-color)/35",
            compact && "svode-calendar-event-compact",
            list && "w-full gap-2 px-0 py-1.5 text-sm",
          )}
          style={eventColorStyle(model.color)}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5",
                  list && "gap-2",
                )}
              >
                <span className="svode-calendar-event-color-bar h-3 w-1 shrink-0 rounded-full bg-(--calendar-event-color)" />
                {model.cardFields.includes("icon") ? (
                  <PageTitleIcon
                    icon={item.meta.icon}
                    className="svode-calendar-event-icon size-4 text-sm leading-none"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="svode-calendar-event-title-row flex min-w-0 items-center gap-1">
                    {arg.timeText && !list ? (
                      <span className="svode-calendar-event-time shrink-0 text-[11px] text-muted-foreground">
                        {arg.timeText}
                      </span>
                    ) : null}
                    <span className="truncate font-medium">
                      {item.meta.title}
                    </span>
                  </div>
                  {conflictPath ? (
                    <div
                      data-page-name-conflict-path
                      className="truncate text-xs text-muted-foreground"
                    >
                      {conflictPath}
                    </div>
                  ) : null}
                  {list &&
                  model.cardFields.includes("description") &&
                  item.meta.description ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {item.meta.description}
                    </div>
                  ) : null}
                </div>
                <PageKindMarker
                  folder={model.folder}
                  nestedCollection={model.nestedCollection}
                  onOpenNested={() => onOpenNestedCollection(item)}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-80">
              <CalendarEventTooltip
                model={model}
                propertyContext={propertyContext}
                readOnly={readOnly}
              />
            </TooltipContent>
          </Tooltip>
          {list && model.customColumns.length > 0 ? (
            <div className="ml-auto hidden max-w-[45%] shrink-0 items-center gap-2 md:flex">
              {model.customColumns.map((column) => (
                <div
                  key={column.name}
                  className="min-w-0 text-xs text-muted-foreground"
                >
                  <CalendarPropertyControl
                    item={item}
                    column={column}
                    propertyContext={propertyContext}
                    readOnly={readOnly}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <CollectionItemContextMenuItems
          item={item}
          nestedCollection={model.nestedCollection}
          onOpenInPeek={openItem}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CalendarEventTooltip({
  model,
  propertyContext,
  readOnly,
}: {
  model: CalendarEventModel;
  propertyContext: CalendarPropertyContext;
  readOnly: boolean;
}) {
  const { item } = model;
  const conflictPath = pageNameConflictDisplayPath(item);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {model.cardFields.includes("icon") ? (
          <PageTitleIcon icon={item.meta.icon} className="size-5" />
        ) : null}
        <div className="min-w-0">
          <div className="truncate font-medium">{item.meta.title}</div>
          {conflictPath ? (
            <div className="truncate text-xs text-muted-foreground">
              {conflictPath}
            </div>
          ) : null}
          {model.cardFields.includes("description") && item.meta.description ? (
            <div className="truncate text-xs text-muted-foreground">
              {item.meta.description}
            </div>
          ) : null}
        </div>
      </div>
      {model.customColumns.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {model.customColumns.map((column) => (
            <div
              key={column.name}
              className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 text-xs"
            >
              <span className="truncate text-muted-foreground">
                {calendarColumnLabel(column)}
              </span>
              <span className="min-w-0 truncate">
                <CalendarPropertyControl
                  item={item}
                  column={column}
                  propertyContext={propertyContext}
                  readOnly={readOnly}
                />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CalendarPropertyControl({
  item,
  column,
  propertyContext,
  readOnly,
}: {
  item: Page;
  column: Column;
  propertyContext: CalendarPropertyContext;
  readOnly: boolean;
}) {
  const value = calendarColumnValue(item, column);
  const validation = validatePropertyValue(column, value);

  if (readOnly || isReadonlyColumn(column)) {
    return (
      <span className="inline-flex min-w-0 max-w-full items-center text-xs">
        <PropertyValue
          column={column}
          value={value}
          actors={propertyContext.actors}
          relationContext={{
            spacePath: propertyContext.spacePath,
            projectPath: propertyContext.projectPath,
            currentFilePath: item.path,
            onOpenPath: propertyContext.onOpenPath,
          }}
        />
      </span>
    );
  }

  return (
    <span
      data-calendar-interactive
      className={cn(
        "inline-flex min-w-0 max-w-full items-center text-xs",
        "[&_[data-slot=button]]:h-6 [&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:rounded-md [&_[data-slot=button]]:px-1.5 [&_[data-slot=button]]:text-xs [&_[data-slot=button]]:font-normal",
        "[&_[data-slot=avatar]]:size-5",
      )}
      onPointerDown={stopInteractivePropagation}
      onClick={stopInteractivePropagation}
      onKeyDown={stopInteractivePropagation}
    >
      <PropertyControl
        column={column}
        value={value}
        invalid={validation.invalid}
        accessibilityLabel={`${column.name}: ${item.meta.title}`}
        density="compact"
        actors={propertyContext.actors}
        relationContext={{
          spacePath: propertyContext.spacePath,
          projectPath: propertyContext.projectPath,
          currentFilePath: item.path,
          onOpenPath: propertyContext.onOpenPath,
        }}
        onRequestActors={propertyContext.onRequestActors}
        onChange={(next) => propertyContext.onUpdateField(item, column, next)}
      />
    </span>
  );
}

function calendarColumnValue(item: Page, column: Column) {
  if (column.name === "created") return item.meta.created;
  if (column.name === "updated") return item.meta.updated;
  return item.meta.extra?.[column.name] ?? null;
}

function calendarColumnLabel(column: Column) {
  if (column.name === "created") return m.collection_field_created();
  if (column.name === "updated") return m.collection_field_updated();
  return column.name;
}

function isReadonlyColumn(column: Column) {
  return (
    column.newer === true ||
    column.name === "created" ||
    column.name === "updated"
  );
}

function PageKindMarker({
  folder,
  nestedCollection,
  onOpenNested,
}: {
  folder: boolean;
  nestedCollection: boolean;
  onOpenNested: () => void;
}) {
  if (nestedCollection) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-calendar-interactive
        className="shrink-0 text-muted-foreground"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenNested();
        }}
      >
        <Database />
        <span className="sr-only">{m.table_open_nested_collection()}</span>
      </Button>
    );
  }
  if (!folder) return null;
  return (
    <span
      className="shrink-0 text-muted-foreground"
      title={m.calendar_folder_marker()}
    >
      <Folder />
    </span>
  );
}

function stopInteractivePropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
