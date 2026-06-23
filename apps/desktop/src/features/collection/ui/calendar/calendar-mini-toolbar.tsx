import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar as DatePickerCalendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { CalendarScope } from "../../model/calendar-types";
import * as m from "@/paraglide/messages.js";

export function CalendarMiniToolbar({
  scope,
  periodLabel,
  currentDate,
  pickerOpen,
  onPickerOpenChange,
  onPrev,
  onNext,
  onToday,
  onScopeChange,
  onGotoDate,
}: {
  scope: CalendarScope;
  periodLabel: string;
  currentDate: Date;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onScopeChange: (scope: CalendarScope) => void;
  onGotoDate: (date: Date) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onPrev}>
          <ChevronLeft />
          <span className="sr-only">{m.calendar_previous_period()}</span>
        </Button>
        {scope === "list" ? (
          <div className="min-w-[160px] truncate px-2 text-sm font-medium">
            {periodLabel || m.collection_view_type_list()}
          </div>
        ) : (
          <Popover open={pickerOpen} onOpenChange={onPickerOpenChange}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-[160px] max-w-[240px] justify-start truncate font-medium"
              >
                <span className="truncate">
                  {periodLabel || m.collection_view_type_calendar()}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-auto overflow-hidden p-0"
            >
              <DatePickerCalendar
                mode="single"
                selected={currentDate}
                defaultMonth={currentDate}
                captionLayout="dropdown"
                onSelect={(date) => {
                  if (date) onGotoDate(date);
                }}
              />
            </PopoverContent>
          </Popover>
        )}
        <Button type="button" variant="ghost" size="icon-sm" onClick={onNext}>
          <ChevronRight />
          <span className="sr-only">{m.calendar_next_period()}</span>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onToday}>
          {m.calendar_today()}
        </Button>
      </div>
      <ToggleGroup
        type="single"
        value={scope}
        variant="outline"
        size="sm"
        onValueChange={(value) => {
          if (value) onScopeChange(value as CalendarScope);
        }}
      >
        <ToggleGroupItem value="month">
          {m.calendar_scope_month()}
        </ToggleGroupItem>
        <ToggleGroupItem value="week">
          {m.calendar_scope_week()}
        </ToggleGroupItem>
        <ToggleGroupItem value="day">{m.calendar_scope_day()}</ToggleGroupItem>
        <ToggleGroupItem value="list">
          {m.calendar_scope_list()}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
