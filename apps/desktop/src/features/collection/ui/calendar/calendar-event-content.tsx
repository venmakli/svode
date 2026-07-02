import type { EventContentArg } from "@fullcalendar/core";
import { Copy, Database, FileText, Folder, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Entry } from "@/features/entry";
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
import { EntryTitleIcon } from "../entry-title-icon";
import * as m from "@/paraglide/messages.js";

export function CalendarEventContent({
  arg,
  scope,
  onOpen,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onDuplicate,
  onDelete,
  propertyContext,
}: {
  arg: EventContentArg;
  scope: CalendarScope;
  onOpen: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onDuplicate: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  propertyContext: CalendarPropertyContext;
}) {
  const model = arg.event.extendedProps.model as CalendarEventModel | undefined;
  if (!model) return null;
  const { entry } = model;
  const list = scope === "list";
  const compact = scope === "week" || scope === "day";

  function openEntry() {
    if (model?.nestedCollection) onOpenNestedPeek(entry);
    else onOpen(entry);
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
                  <EntryTitleIcon
                    icon={entry.meta.icon}
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
                      {entry.meta.title}
                    </span>
                  </div>
                  {list &&
                  model.cardFields.includes("description") &&
                  entry.meta.description ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {entry.meta.description}
                    </div>
                  ) : null}
                </div>
                <EntryKindMarker
                  folder={model.folder}
                  nestedCollection={model.nestedCollection}
                  onOpenNested={() => onOpenNestedCollection(entry)}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-80">
              <CalendarEventTooltip
                model={model}
                propertyContext={propertyContext}
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
                    entry={entry}
                    column={column}
                    propertyContext={propertyContext}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={openEntry}>
          <FileText data-icon="inline-start" />
          {m.collection_open_in_peek()}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDuplicate(entry)}>
          <Copy data-icon="inline-start" />
          {m.collection_duplicate_entry()}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => onDelete(entry)}>
          <Trash2 data-icon="inline-start" />
          {m.space_delete()}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CalendarEventTooltip({
  model,
  propertyContext,
}: {
  model: CalendarEventModel;
  propertyContext: CalendarPropertyContext;
}) {
  const { entry } = model;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {model.cardFields.includes("icon") ? (
          <EntryTitleIcon icon={entry.meta.icon} className="size-5" />
        ) : null}
        <div className="min-w-0">
          <div className="truncate font-medium">{entry.meta.title}</div>
          {model.cardFields.includes("description") &&
          entry.meta.description ? (
            <div className="truncate text-xs text-muted-foreground">
              {entry.meta.description}
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
                  entry={entry}
                  column={column}
                  propertyContext={propertyContext}
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
  entry,
  column,
  propertyContext,
}: {
  entry: Entry;
  column: Column;
  propertyContext: CalendarPropertyContext;
}) {
  const value = calendarColumnValue(entry, column);
  const validation = validatePropertyValue(column, value);

  if (isReadonlySystemColumn(column)) {
    return (
      <span className="inline-flex min-w-0 max-w-full items-center text-xs">
        <PropertyValue
          column={column}
          value={value}
          actors={propertyContext.actors}
          relationContext={{
            spacePath: propertyContext.spacePath,
            projectPath: propertyContext.projectPath,
            currentFilePath: entry.path,
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
        actors={propertyContext.actors}
        relationContext={{
          spacePath: propertyContext.spacePath,
          projectPath: propertyContext.projectPath,
          currentFilePath: entry.path,
          onOpenPath: propertyContext.onOpenPath,
        }}
        onRequestActors={propertyContext.onRequestActors}
        onChange={(next) => propertyContext.onUpdateField(entry, column, next)}
      />
    </span>
  );
}

function calendarColumnValue(entry: Entry, column: Column) {
  if (column.name === "created") return entry.meta.created;
  if (column.name === "updated") return entry.meta.updated;
  return entry.meta.extra?.[column.name] ?? null;
}

function calendarColumnLabel(column: Column) {
  if (column.name === "created") return m.collection_field_created();
  if (column.name === "updated") return m.collection_field_updated();
  return column.name;
}

function isReadonlySystemColumn(column: Column) {
  return column.name === "created" || column.name === "updated";
}

function EntryKindMarker({
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
