import type FullCalendar from "@fullcalendar/react";
import type {
  CalendarApi,
  DatesSetArg,
  DayCellMountArg,
} from "@fullcalendar/core";
import type { CalendarEventInput } from "./calendar-adapter";
import * as m from "@/paraglide/messages.js";

export function handleDatesSet(
  arg: DatesSetArg,
  setPeriodLabel: (value: string) => void,
  setCurrentDate: (value: Date) => void,
  setVisibleRange: (value: { start: Date; end: Date }) => void,
) {
  setPeriodLabel(arg.view.title);
  setCurrentDate(arg.view.calendar.getDate());
  setVisibleRange({ start: arg.start, end: arg.end });
}

export function calendarApi(ref: FullCalendar | null): CalendarApi | null {
  return ref?.getApi() ?? null;
}

export function anchorFromMouse(event: MouseEvent) {
  return {
    x: Math.min(event.clientX, window.innerWidth - 320),
    y: Math.min(event.clientY, window.innerHeight - 140),
  };
}

export function createAnchorFromShell(shell: HTMLDivElement | null) {
  const rect = shell?.getBoundingClientRect();
  return {
    x: rect ? rect.left + rect.width / 2 - 140 : window.innerWidth / 2 - 140,
    y: rect ? rect.top + 72 : 120,
  };
}

export function formatLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nearestListCreateDate(
  events: CalendarEventInput[],
  range: { start: Date; end: Date } | null,
  fallback: Date,
) {
  const visibleStarts = events
    .map((event) => parseCalendarDate(event.start))
    .filter((date): date is Date => Boolean(date))
    .filter((date) => !range || (date >= range.start && date < range.end))
    .sort((left, right) => left.getTime() - right.getTime());
  return visibleStarts[0] ?? fallback;
}

export function mountCalendarDayNewButton(
  arg: DayCellMountArg,
  onCreate: (event: MouseEvent, date: Date) => void,
) {
  if (
    !["dayGridMonth", "timeGridWeek", "timeGridDay"].includes(arg.view.type) ||
    arg.isOther ||
    arg.isDisabled
  ) {
    return;
  }
  const frame = arg.el.querySelector<HTMLElement>(".fc-daygrid-day-frame");
  if (!frame) return;
  unmountCalendarDayNewButton(arg);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "svode-calendar-day-new";
  button.dataset.calendarInteractive = "true";
  button.dataset.calendarDayNew = "true";

  const plus = document.createElement("span");
  plus.setAttribute("aria-hidden", "true");
  plus.textContent = "+";
  const label = document.createElement("span");
  label.textContent = m.calendar_new_entry_short();
  button.append(plus, label);

  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCreate(event, arg.date);
  });

  frame.append(button);
}

export function unmountCalendarDayNewButton(arg: DayCellMountArg) {
  arg.el.querySelector("[data-calendar-day-new='true']")?.remove();
}

export function isInteractiveEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[data-calendar-interactive]",
        "[data-radix-collection-item]",
      ].join(","),
    ),
  );
}

function parseCalendarDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const date = new Date(value.includes("T") ? value : `${value}T00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
