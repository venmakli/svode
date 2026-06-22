import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/shared/lib/utils";
import {
  formatDateValue,
  isEmptyValue,
  normalizeDateInput,
  todayIsoDate,
} from "../../lib/utils";
import type { DateRangeValue } from "../../model/types";
import * as m from "@/paraglide/messages.js";
import { deferStateUpdate, useAutoOpen } from "./common";
import type { PropertyControlProps } from "./types";

export function DateControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const normalized = normalizeDateInput(value);
  const [startDate, setStartDate] = useState(datePart(normalized.start));
  const [startTime, setStartTime] = useState(timePart(normalized.start));
  const [endDate, setEndDate] = useState(datePart(normalized.end));
  const [endTime, setEndTime] = useState(timePart(normalized.end));
  const [hasTime, setHasTime] = useState(
    normalized.hasTime || Boolean(column.timeByDefault),
  );
  const [isRange, setIsRange] = useState(
    normalized.isRange || Boolean(column.rangeByDefault),
  );

  useEffect(() => {
    return deferStateUpdate(() => {
      const next = normalizeDateInput(value);
      setStartDate(datePart(next.start));
      setStartTime(timePart(next.start));
      setEndDate(datePart(next.end));
      setEndTime(timePart(next.end));
      setHasTime(
        next.hasTime || (isEmptyValue(value) && Boolean(column.timeByDefault)),
      );
      setIsRange(
        next.isRange || (isEmptyValue(value) && Boolean(column.rangeByDefault)),
      );
    });
  }, [column.rangeByDefault, column.timeByDefault, value]);

  const apply = (
    next?: Partial<{
      startDate: string;
      startTime: string;
      endDate: string;
      endTime: string;
      hasTime: boolean;
      isRange: boolean;
    }>,
  ) => {
    const nextStartDate = next?.startDate ?? startDate;
    const nextStartTime = next?.startTime ?? startTime;
    const nextEndDate = next?.endDate ?? endDate;
    const nextEndTime = next?.endTime ?? endTime;
    const nextHasTime = next?.hasTime ?? hasTime;
    const nextIsRange = next?.isRange ?? isRange;
    if (!nextStartDate) {
      void onChange(null);
      return;
    }
    const start = combineDateTime(nextStartDate, nextStartTime, nextHasTime);
    if (!nextIsRange) {
      void onChange(start);
      return;
    }
    const end = combineDateTime(
      nextEndDate || nextStartDate,
      nextEndTime || nextStartTime,
      nextHasTime,
    );
    void onChange({ start, end } satisfies DateRangeValue);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full min-w-0 justify-start",
            invalid && "border-warning",
          )}
        >
          <span className="truncate">
            {formatDateValue(value, column.display) || m.property_empty()}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-[1fr_auto] items-center gap-2">
            <Input
              type="date"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
                apply({ startDate: event.target.value });
              }}
            />
            {hasTime ? (
              <Input
                type="time"
                value={startTime}
                onChange={(event) => {
                  setStartTime(event.target.value);
                  apply({ startTime: event.target.value });
                }}
                className="w-28"
              />
            ) : null}
          </div>
          {isRange ? (
            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
              <Input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  apply({ endDate: event.target.value });
                }}
              />
              {hasTime ? (
                <Input
                  type="time"
                  value={endTime}
                  onChange={(event) => {
                    setEndTime(event.target.value);
                    apply({ endTime: event.target.value });
                  }}
                  className="w-28"
                />
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {m.property_date_time()}
            </span>
            <Switch
              checked={hasTime}
              onCheckedChange={(checked) => {
                setHasTime(checked);
                apply({ hasTime: checked });
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {m.property_date_range()}
            </span>
            <Switch
              checked={isRange}
              onCheckedChange={(checked) => {
                setIsRange(checked);
                apply({ isRange: checked, endDate: endDate || startDate });
              }}
            />
          </div>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = todayIsoDate();
                setStartDate(next);
                setEndDate(next);
                apply({ startDate: next, endDate: next });
              }}
            >
              {m.property_date_today()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = todayIsoDate(1);
                setStartDate(next);
                setEndDate(next);
                apply({ startDate: next, endDate: next });
              }}
            >
              {m.property_date_tomorrow()}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setStartDate("");
                setEndDate("");
                void onChange(null);
              }}
            >
              {m.property_action_clear()}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function datePart(value: string): string {
  return value.split("T")[0] ?? "";
}

function timePart(value: string): string {
  return value.includes("T") ? (value.split("T")[1]?.slice(0, 5) ?? "") : "";
}

function combineDateTime(date: string, time: string, hasTime: boolean): string {
  return hasTime ? `${date}T${time || "09:00"}` : date;
}
