import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import * as m from "@/paraglide/messages.js";

import {
  currentSystemTimezone,
  projectRoutineTimezoneOptions,
  supportedTimezones,
  timezoneCityLabel,
} from "../model/routine-time-basis";
import type { RoutineTimeBasis } from "../model/types";

export function RoutineTimezonePicker({
  id,
  invalid,
  onChange,
  value,
}: {
  id: string;
  invalid: boolean;
  onChange(value: RoutineTimeBasis): void;
  value: RoutineTimeBasis;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const currentTimezone = currentSystemTimezone();
  const timezones = useMemo(() => supportedTimezones(), []);
  const {
    fixedTimezones: visibleTimezones,
    showCurrent,
    showLocal,
  } = projectRoutineTimezoneOptions({
    currentTimezone,
    localSearchText: `${m.routines_timezone_local()} ${m.routines_timezone_local_description()}`,
    query,
    timezones,
  });

  const select = (timeBasis: RoutineTimeBasis) => {
    onChange(timeBasis);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          className="w-full justify-between font-normal"
          data-routine-create-focus="trigger"
        >
          <span className="min-w-0 truncate">{timeBasisLabel(value)}</span>
          <ChevronsUpDown data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            placeholder={m.routines_timezone_search()}
            onValueChange={setQuery}
          />
          <CommandList>
            {!showLocal && !showCurrent && visibleTimezones.length === 0 ? (
              <CommandEmpty>{m.routines_timezone_empty()}</CommandEmpty>
            ) : null}
            {showLocal || showCurrent ? (
              <CommandGroup heading={m.routines_timezone_recommended()}>
                {showLocal ? (
                  <CommandItem
                    value="local"
                    data-checked={value.mode === "local"}
                    onSelect={() => select({ mode: "local" })}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span>{m.routines_timezone_local()}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {m.routines_timezone_local_description()}
                      </span>
                    </span>
                  </CommandItem>
                ) : null}
                {showCurrent && currentTimezone ? (
                  <TimezoneItem
                    timezone={currentTimezone}
                    checked={
                      value.mode === "fixed" &&
                      value.timezone === currentTimezone
                    }
                    label={m.routines_timezone_current({
                      timezone: timezoneCityLabel(currentTimezone),
                    })}
                    onSelect={() =>
                      select({ mode: "fixed", timezone: currentTimezone })
                    }
                  />
                ) : null}
              </CommandGroup>
            ) : null}
            {visibleTimezones.length > 0 ? (
              <>
                {showLocal || showCurrent ? <CommandSeparator /> : null}
                <CommandGroup heading={m.routines_timezone_all()}>
                  {visibleTimezones.map((timezone) => (
                    <TimezoneItem
                      key={timezone}
                      timezone={timezone}
                      checked={
                        value.mode === "fixed" && value.timezone === timezone
                      }
                      onSelect={() => select({ mode: "fixed", timezone })}
                    />
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TimezoneItem({
  checked,
  label,
  onSelect,
  timezone,
}: {
  checked: boolean;
  label?: string;
  onSelect(): void;
  timezone: string;
}) {
  return (
    <CommandItem
      value={`fixed:${timezone}`}
      data-checked={checked}
      onSelect={onSelect}
    >
      <span className="flex min-w-0 flex-col">
        <span>{label ?? timezoneCityLabel(timezone)}</span>
        <span className="truncate text-xs text-muted-foreground">
          {timezone}
        </span>
      </span>
    </CommandItem>
  );
}

function timeBasisLabel(timeBasis: RoutineTimeBasis) {
  if (timeBasis.mode === "local") return m.routines_timezone_local();
  return `${m.routines_timezone_fixed()} · ${timezoneCityLabel(timeBasis.timezone)} (${timeBasis.timezone})`;
}
