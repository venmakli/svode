import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type FullCalendar from "@fullcalendar/react";
import type {
  DateClickArg,
  EventResizeDoneArg,
} from "@fullcalendar/interaction";
import type {
  DateSelectArg,
  DayCellMountArg,
  EventClickArg,
  EventDropArg,
} from "@fullcalendar/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { addCollectionDateColumn } from "@/features/collection/api";
import { useCollectionActors } from "@/features/collection/hooks";
import type { Entry } from "@/features/entry";
import { normalizeSchema } from "@/features/properties";
import { propertyFieldSavePolicy } from "@/features/properties/entry-save-policy";
import type { Column } from "@/features/properties";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import { getLocale } from "@/paraglide/runtime.js";
import { uniqueColumnName } from "../table/utils";
import {
  anchorFromMouse,
  calendarApi,
  createAnchorFromShell,
  formatLocalDate,
  handleDatesSet,
  isInteractiveEventTarget,
  mountCalendarDayNewButton,
  nearestListCreateDate,
} from "./calendar-dom";
import { CalendarEngine } from "./calendar-engine";
import { CalendarMiniToolbar } from "./calendar-mini-toolbar";
import {
  CalendarEmptyOverlay,
  CalendarLoadingState,
  NoDateFieldState,
} from "./calendar-states";
import { CalendarTitlePopover } from "./calendar-title-popover";
import type {
  CalendarCreateDraft,
  CalendarEventInput,
  CalendarScope,
  CalendarViewProps,
} from "./types";
import {
  buildCalendarEvents,
  calendarCustomFields,
  calendarDateColumn,
  dateValueFromClick,
  dateValueFromSelection,
  fullCalendarViewForScope,
  hiddenNoDateCount,
  initialCalendarScope,
  normalizeCalendarCardFields,
  setCalendarScopeQuery,
  valueFromEventDrop,
  valueFromEventResize,
  visibleEventCount,
} from "./utils";
import { useCalendarEntries } from "./use-calendar-entries";
import * as m from "@/paraglide/messages.js";

export function CalendarView({
  name,
  view,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  searchQuery,
  filters,
  sort,
  refreshToken,
  createFocusSignal = 0,
  createAsFolder = false,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onOpenPath,
  onDuplicateEntry,
  onDeleteEntry,
  onSchemaChange,
  onUpdateView,
  onCreateEntry,
}: CalendarViewProps) {
  const calendarRef = useRef<FullCalendar | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [scope, setScope] = useState<CalendarScope>(() =>
    initialCalendarScope(view),
  );
  const [periodLabel, setPeriodLabel] = useState("");
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [visibleRange, setVisibleRange] = useState<{
    start: Date;
    end: Date;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CalendarCreateDraft | null>(
    null,
  );
  const { actors, loadActors } = useCollectionActors(spacePath);
  const {
    entries,
    setEntries,
    nestedCollectionPaths,
    loading,
    loadEntries,
    updateField,
  } = useCalendarEntries({
    collectionPath,
    filters,
    projectPath,
    refreshToken,
    sort,
    spacePath,
  });

  const dateColumn = useMemo(
    () => calendarDateColumn(view, schema),
    [schema, view],
  );
  const cardFields = useMemo(
    () => normalizeCalendarCardFields(view, schema),
    [schema, view],
  );
  const customColumns = useMemo(
    () =>
      dateColumn
        ? calendarCustomFields(cardFields, schema, dateColumn.name)
        : [],
    [cardFields, dateColumn, schema],
  );
  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) =>
      entry.meta.title.toLowerCase().includes(query),
    );
  }, [entries, searchQuery]);
  const events = useMemo<CalendarEventInput[]>(
    () =>
      dateColumn
        ? buildCalendarEvents({
            entries: filteredEntries,
            view,
            schema,
            dateColumn,
            cardFields,
            customColumns,
            nestedCollectionPaths,
          })
        : [],
    [
      cardFields,
      customColumns,
      dateColumn,
      filteredEntries,
      nestedCollectionPaths,
      schema,
      view,
    ],
  );
  const hiddenCount = dateColumn
    ? hiddenNoDateCount(filteredEntries, dateColumn)
    : 0;
  const visibleCount = visibleEventCount(events, visibleRange);
  const hasActorCardField = customColumns.some(
    (column) => column.type === "actor",
  );
  const locale = getLocale();

  useEffect(() => {
    const api = calendarApi(calendarRef.current);
    if (!api) return;
    api.changeView(fullCalendarViewForScope(scope));
    setCalendarScopeQuery(scope);
  }, [scope]);

  useEffect(() => {
    if (createFocusSignal <= 0 || !dateColumn) return;
    const api = calendarApi(calendarRef.current);
    const fallbackDate = api ? api.getDate() : new Date();
    const createDate =
      scope === "list"
        ? nearestListCreateDate(events, visibleRange, fallbackDate)
        : fallbackDate;
    const anchor = createAnchorFromShell(shellRef.current);
    setCreateDraft({
      anchor,
      dateValue: dateValueFromClick(formatLocalDate(createDate), true),
      asFolder: createAsFolder,
    });
  }, [
    createAsFolder,
    createFocusSignal,
    dateColumn,
    events,
    scope,
    visibleRange,
  ]);

  useEffect(() => {
    if (!hasActorCardField) return;
    void loadActors().catch((error) => {
      console.warn("Failed to load calendar actors:", error);
    });
  }, [hasActorCardField, loadActors]);

  async function handleAddDateColumn() {
    const fieldName = uniqueColumnName(schema, m.collection_date_field());
    const next = await addCollectionDateColumn({
      spacePath,
      collectionPath,
      column: { name: fieldName, type: "date" },
      projectPath,
    });
    const normalized = normalizeSchema(next);
    onSchemaChange(normalized);
    await onUpdateView(name, { date_field: fieldName });
  }

  const propertyContext = useMemo(
    () => ({
      spacePath,
      projectPath,
      onOpenPath,
      actors,
      onRequestActors: loadActors,
      onUpdateField: (entry: Entry, column: Column, value: unknown) => {
        void updateField(entry, column.name, value, {
          policy: propertyFieldSavePolicy(column),
        });
      },
    }),
    [loadActors, actors, onOpenPath, projectPath, spacePath, updateField],
  );

  const handleDayCellDidMount = useCallback(
    (arg: DayCellMountArg) => {
      mountCalendarDayNewButton(arg, (event, date) => {
        if (!dateColumn) return;
        setCreateDraft({
          anchor: anchorFromMouse(event),
          dateValue: dateValueFromClick(formatLocalDate(date), true),
          asFolder: false,
        });
      });
    },
    [dateColumn],
  );

  function handleDateClick(info: DateClickArg) {
    if (!dateColumn || scope === "list") return;
    setCreateDraft({
      anchor: anchorFromMouse(info.jsEvent),
      dateValue: dateValueFromClick(info.dateStr, info.allDay),
      asFolder: false,
    });
  }

  function handleSelect(selection: DateSelectArg) {
    if (!dateColumn || scope === "list") return;
    setCreateDraft({
      anchor: selection.jsEvent
        ? anchorFromMouse(selection.jsEvent)
        : createAnchorFromShell(shellRef.current),
      dateValue: dateValueFromSelection(selection, dateColumn),
      asFolder: false,
    });
    calendarApi(calendarRef.current)?.unselect();
  }

  function handleEventClick(info: EventClickArg) {
    if (isInteractiveEventTarget(info.jsEvent.target)) return;
    const model = info.event.extendedProps.model as
      | CalendarEventInput["extendedProps"]["model"]
      | undefined;
    if (!model) return;
    if (info.jsEvent.detail >= 2) {
      onOpenFullPage(model.entry);
      return;
    }
    if (model.nestedCollection) onOpenNestedPeek(model.entry);
    else onOpenEntry(model.entry);
  }

  function handleEventDrop(info: EventDropArg) {
    if (scope === "list") {
      info.revert();
      return;
    }
    const model = info.oldEvent.extendedProps.model as
      | CalendarEventInput["extendedProps"]["model"]
      | undefined;
    const nextValue = valueFromEventDrop(info);
    if (!model || !nextValue || !dateColumn) {
      info.revert();
      return;
    }
    void updateField(model.entry, model.dateField, nextValue, {
      revert: info.revert,
      policy: propertyFieldSavePolicy(dateColumn),
    });
  }

  function handleEventResize(info: EventResizeDoneArg) {
    if (scope === "list") {
      info.revert();
      return;
    }
    const model = info.oldEvent.extendedProps.model as
      | CalendarEventInput["extendedProps"]["model"]
      | undefined;
    const nextValue = valueFromEventResize(info);
    if (!model || !nextValue || !dateColumn) {
      info.revert();
      return;
    }
    void updateField(model.entry, model.dateField, nextValue, {
      revert: info.revert,
      policy: propertyFieldSavePolicy(dateColumn),
    });
  }

  async function handleCreate(title: string, draft: CalendarCreateDraft) {
    if (!dateColumn) return;
    const created = await onCreateEntry(title, draft.asFolder, {
      [dateColumn.name]: draft.dateValue,
    });
    setCreateDraft(null);
    setEntries((current) => [...current, created]);
    await loadEntries();
  }

  if (!dateColumn) {
    return (
      <NoDateFieldState
        loading={loading}
        onAddDateColumn={() => void handleAddDateColumn().catch(handleError)}
      />
    );
  }

  if (loading) {
    return <CalendarLoadingState />;
  }

  return (
    <div ref={shellRef} className={detailPageViewClassName}>
      <div className="svode-calendar flex flex-col rounded-lg bg-background ring-1 ring-foreground/10">
        <CalendarMiniToolbar
          scope={scope}
          periodLabel={periodLabel}
          currentDate={currentDate}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          onPrev={() => calendarApi(calendarRef.current)?.prev()}
          onNext={() => calendarApi(calendarRef.current)?.next()}
          onToday={() => calendarApi(calendarRef.current)?.today()}
          onScopeChange={setScope}
          onGotoDate={(date) => {
            calendarApi(calendarRef.current)?.gotoDate(date);
            setPickerOpen(false);
          }}
        />
        <div className="relative overflow-visible">
          <CalendarEngine
            calendarRef={calendarRef}
            scope={scope}
            events={events}
            locale={locale}
            propertyContext={propertyContext}
            onDateClick={handleDateClick}
            onSelect={handleSelect}
            onEventClick={handleEventClick}
            onEventDrop={handleEventDrop}
            onEventResize={handleEventResize}
            onDayCellDidMount={handleDayCellDidMount}
            onDatesSet={(arg) =>
              handleDatesSet(
                arg,
                setPeriodLabel,
                setCurrentDate,
                setVisibleRange,
              )
            }
            onOpenEntry={onOpenEntry}
            onOpenNestedPeek={onOpenNestedPeek}
            onOpenNestedCollection={onOpenNestedCollection}
            onDuplicateEntry={onDuplicateEntry}
            onDeleteEntry={onDeleteEntry}
          />
          {visibleCount === 0 ? <CalendarEmptyOverlay /> : null}
        </div>
        {hiddenCount > 0 ? (
          <div className="flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{m.calendar_hidden_no_date({ count: hiddenCount })}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setScope("list")}
            >
              {m.calendar_show_as_list()}
            </Button>
          </div>
        ) : null}
      </div>
      <CalendarTitlePopover
        draft={createDraft}
        onCancel={() => setCreateDraft(null)}
        onCreate={(title, draft) =>
          void handleCreate(title, draft).catch(handleError)
        }
      />
    </div>
  );
}

function handleError(error: unknown) {
  console.error(error);
  toast.error(String(error));
}
