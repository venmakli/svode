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
import type { Page } from "@/features/page";
import { CalendarEventContent } from "./calendar-event-content";
import { unmountCalendarDayNewButton } from "../../hooks/calendar/calendar-dom";
import type {
  CalendarPropertyContext,
  CalendarScope,
} from "../../model/calendar-types";
import {
  fullCalendarViewForScope,
  type CalendarEventInput,
} from "../../hooks/calendar/calendar-adapter";

export function CalendarEngine({
  readOnly,
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
  onActivateItem,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onDuplicatePage,
  onDeletePage,
}: {
  readOnly: boolean;
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
  onActivateItem: (page: Page) => void;
  onOpenNestedPeek: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onDuplicatePage: (page: Page) => void;
  onDeletePage: (page: Page) => void;
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
      editable={!readOnly && scope !== "list"}
      selectable={!readOnly && scope !== "list"}
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
      dateClick={readOnly ? undefined : onDateClick}
      select={readOnly ? undefined : onSelect}
      eventClick={onEventClick}
      eventDrop={readOnly ? undefined : onEventDrop}
      eventResize={readOnly ? undefined : onEventResize}
      dayCellDidMount={readOnly ? undefined : onDayCellDidMount}
      dayCellWillUnmount={unmountCalendarDayNewButton}
      datesSet={onDatesSet}
      eventContent={(arg) => (
        <CalendarEventContent
          readOnly={readOnly}
          arg={arg}
          scope={scope}
          onOpen={onActivateItem}
          onOpenNestedPeek={onOpenNestedPeek}
          onOpenNestedCollection={onOpenNestedCollection}
          onDuplicate={onDuplicatePage}
          onDelete={onDeletePage}
          propertyContext={propertyContext}
        />
      )}
    />
  );
}
