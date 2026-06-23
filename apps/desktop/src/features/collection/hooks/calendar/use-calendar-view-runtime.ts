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
import { propertyFieldSavePolicy, type Entry } from "@/features/entry";
import type { Column } from "@/features/properties";
import { getLocale } from "@/paraglide/runtime.js";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionColumnActions } from "../use-collection-column-actions";
import * as m from "@/paraglide/messages.js";
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
import type { CalendarCreateDraft, CalendarViewProps } from "../../model/calendar-types";
import {
  calendarCustomFields,
  calendarDateColumn,
  dateValueFromClick,
  dateValueFromSelection,
  hiddenNoDateCount,
  normalizeCalendarCardFields,
} from "../../model/calendar-utils";
import {
  buildCalendarEvents,
  fullCalendarViewForScope,
  valueFromEventDrop,
  valueFromEventResize,
  visibleEventCount,
  type CalendarEventInput,
} from "./calendar-adapter";
import { useCalendarEntries } from "./use-calendar-entries";
import { useCalendarScopeQuery } from "./use-calendar-scope-query";

export function useCalendarViewRuntime({
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
  onOpenFullPage,
  onOpenPath,
  onSchemaChange,
  onUpdateView,
  onCreateEntry,
}: CalendarViewProps) {
  const calendarRef = useRef<FullCalendar | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [scope, setScope] = useCalendarScopeQuery(view);
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
  const { addDateColumn } = useCollectionColumnActions({
    schema,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });
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

  const addDateColumnForView = useCallback(async () => {
    const { name: fieldName } = await addDateColumn({
      baseName: m.collection_date_field(),
    });
    await onUpdateView(name, { date_field: fieldName });
  }, [addDateColumn, name, onUpdateView]);

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

  const handleDateClick = useCallback(
    (info: DateClickArg) => {
      if (!dateColumn || scope === "list") return;
      setCreateDraft({
        anchor: anchorFromMouse(info.jsEvent),
        dateValue: dateValueFromClick(info.dateStr, info.allDay),
        asFolder: false,
      });
    },
    [dateColumn, scope],
  );

  const handleSelect = useCallback(
    (selection: DateSelectArg) => {
      if (!dateColumn || scope === "list") return;
      setCreateDraft({
        anchor: selection.jsEvent
          ? anchorFromMouse(selection.jsEvent)
          : createAnchorFromShell(shellRef.current),
        dateValue: dateValueFromSelection(selection, dateColumn),
        asFolder: false,
      });
      calendarApi(calendarRef.current)?.unselect();
    },
    [dateColumn, scope],
  );

  const handleEventClick = useCallback(
    (info: EventClickArg) => {
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
    },
    [onOpenEntry, onOpenFullPage, onOpenNestedPeek],
  );

  const handleEventDrop = useCallback(
    (info: EventDropArg) => {
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
    },
    [dateColumn, scope, updateField],
  );

  const handleEventResize = useCallback(
    (info: EventResizeDoneArg) => {
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
    },
    [dateColumn, scope, updateField],
  );

  const createEntryFromDraft = useCallback(
    async (title: string, draft: CalendarCreateDraft) => {
      if (!dateColumn) return;
      const created = await onCreateEntry(title, draft.asFolder, {
        [dateColumn.name]: draft.dateValue,
      });
      setCreateDraft(null);
      setEntries((current) => [...current, created]);
      await loadEntries();
    },
    [dateColumn, loadEntries, onCreateEntry, setEntries],
  );

  const syncDates = useCallback(
    (arg: Parameters<typeof handleDatesSet>[0]) =>
      handleDatesSet(arg, setPeriodLabel, setCurrentDate, setVisibleRange),
    [],
  );

  return {
    calendarRef,
    shellRef,
    scope,
    periodLabel,
    currentDate,
    pickerOpen,
    setPickerOpen,
    createDraft,
    setCreateDraft,
    loading,
    dateColumn,
    events,
    hiddenCount,
    visibleCount,
    locale,
    propertyContext,
    addDateColumnForView,
    handleDateClick,
    handleDayCellDidMount,
    handleEventClick,
    handleEventDrop,
    handleEventResize,
    handleSelect,
    syncDates,
    createEntryFromDraft,
    goToPrevious: () => calendarApi(calendarRef.current)?.prev(),
    goToNext: () => calendarApi(calendarRef.current)?.next(),
    goToToday: () => calendarApi(calendarRef.current)?.today(),
    setScope,
    setListScope: () => setScope("list"),
    goToDate: (date: Date) => {
      calendarApi(calendarRef.current)?.gotoDate(date);
      setPickerOpen(false);
    },
  };
}

export function reportCalendarError(error: unknown) {
  console.error(error);
  toast.error(String(error));
}
