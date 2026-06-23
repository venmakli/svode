import type { RefObject } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin, {
  type DateClickArg,
  type EventResizeDoneArg,
} from "@fullcalendar/interaction";
import type {
  DateSelectArg,
  DatesSetArg,
  DayCellMountArg,
  EventClickArg,
  EventDropArg,
} from "@fullcalendar/core";
import ruLocale from "@fullcalendar/core/locales/ru";
import type { Entry } from "@/features/entry";
import { CalendarEventContent } from "./calendar-event-content";
import { unmountCalendarDayNewButton } from "../../lib/calendar-dom";
import type {
  CalendarEventInput,
  CalendarPropertyContext,
  CalendarScope,
} from "../../model/calendar-types";
import { fullCalendarViewForScope } from "../../model/calendar-utils";

export function CalendarEngine({
  calendarRef,
  scope,
  events,
  locale,
  propertyContext,
  onDateClick,
  onSelect,
  onEventClick,
  onEventDrop,
  onEventResize,
  onDayCellDidMount,
  onDatesSet,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onDuplicateEntry,
  onDeleteEntry,
}: {
  calendarRef: RefObject<FullCalendar | null>;
  scope: CalendarScope;
  events: CalendarEventInput[];
  locale: string;
  propertyContext: CalendarPropertyContext;
  onDateClick: (arg: DateClickArg) => void;
  onSelect: (arg: DateSelectArg) => void;
  onEventClick: (arg: EventClickArg) => void;
  onEventDrop: (arg: EventDropArg) => void;
  onEventResize: (arg: EventResizeDoneArg) => void;
  onDayCellDidMount: (arg: DayCellMountArg) => void;
  onDatesSet: (arg: DatesSetArg) => void;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
}) {
  return (
    <FullCalendar
      ref={calendarRef}
      plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
      initialView={fullCalendarViewForScope(scope)}
      headerToolbar={false}
      height="auto"
      events={events}
      locale={locale === "ru" ? ruLocale : "en"}
      firstDay={1}
      nowIndicator
      editable={scope !== "list"}
      selectable={scope !== "list"}
      selectMirror
      eventResizableFromStart
      eventDragMinDistance={6}
      selectMinDistance={6}
      longPressDelay={450}
      eventLongPressDelay={450}
      selectLongPressDelay={450}
      dayMaxEvents
      allDayMaintainDuration
      displayEventEnd
      dateClick={onDateClick}
      select={onSelect}
      eventClick={onEventClick}
      eventDrop={onEventDrop}
      eventResize={onEventResize}
      dayCellDidMount={onDayCellDidMount}
      dayCellWillUnmount={unmountCalendarDayNewButton}
      datesSet={onDatesSet}
      eventContent={(arg) => (
        <CalendarEventContent
          arg={arg}
          scope={scope}
          onOpen={onOpenEntry}
          onOpenNestedPeek={onOpenNestedPeek}
          onOpenNestedCollection={onOpenNestedCollection}
          onDuplicate={onDuplicateEntry}
          onDelete={onDeleteEntry}
          propertyContext={propertyContext}
        />
      )}
    />
  );
}
