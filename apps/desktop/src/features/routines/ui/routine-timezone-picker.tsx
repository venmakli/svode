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
import { getLocale } from "@/paraglide/runtime.js";

import {
  currentSystemTimezone,
  projectRoutineTimezoneOptions,
  supportedTimezones,
  timezoneDisplayLabel,
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
  const locale = getLocale();
  const currentTimezone = currentSystemTimezone();
  const timezones = useMemo(() => supportedTimezones(), []);
  const {
    fixedTimezones: visibleTimezones,
    showCurrent,
    showLocal,
  } = projectRoutineTimezoneOptions({
    currentTimezone,
    localSearchText: m.routines_timezone_local(),
    locale,
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
          <span className="min-w-0 truncate">
            {timeBasisLabel(value, locale)}
          </span>
          <ChevronsUpDown data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[var(--radix-popover-content-available-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={m.routines_timezone_search()}
            value={query}
            placeholder={m.routines_timezone_search()}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-64">
            {!showLocal && !showCurrent && visibleTimezones.length === 0 ? (
              <CommandEmpty>{m.routines_timezone_empty()}</CommandEmpty>
            ) : null}
            {showLocal ? (
              <CommandGroup>
                <CommandItem
                  value="local"
                  data-checked={value.mode === "local"}
                  onSelect={() => select({ mode: "local" })}
                >
                  <span className="truncate">
                    {m.routines_timezone_local()}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {showCurrent || visibleTimezones.length > 0 ? (
              <>
                {showLocal ? <CommandSeparator /> : null}
                <CommandGroup>
                  {showCurrent && currentTimezone ? (
                    <TimezoneItem
                      timezone={currentTimezone}
                      locale={locale}
                      checked={
                        value.mode === "fixed" &&
                        value.timezone === currentTimezone
                      }
                      onSelect={() =>
                        select({ mode: "fixed", timezone: currentTimezone })
                      }
                    />
                  ) : null}
                  {visibleTimezones.map((timezone) => (
                    <TimezoneItem
                      key={timezone}
                      timezone={timezone}
                      locale={locale}
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
  locale,
  onSelect,
  timezone,
}: {
  checked: boolean;
  locale: string;
  onSelect(): void;
  timezone: string;
}) {
  return (
    <CommandItem
      value={`fixed:${timezone}`}
      data-checked={checked}
      onSelect={onSelect}
    >
      <span className="truncate">
        {timezoneDisplayLabel(timezone, locale)}
      </span>
    </CommandItem>
  );
}

function timeBasisLabel(timeBasis: RoutineTimeBasis, locale: string) {
  if (timeBasis.mode === "local") return m.routines_timezone_local();
  return timezoneDisplayLabel(timeBasis.timezone, locale);
}
