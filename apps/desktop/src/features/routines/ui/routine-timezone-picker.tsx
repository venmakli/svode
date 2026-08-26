import { useMemo } from "react";

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import {
  MAX_VISIBLE_TIMEZONES,
  currentSystemTimezone,
  groupRoutineTimezones,
  supportedTimezones,
  timezoneDisplayLabel,
  type RoutineTimezoneRegion,
} from "../model/routine-time-basis";
import type { RoutineTimeBasis } from "../model/types";

interface TimezoneOption {
  label: string;
  searchValue: string;
  timeBasis: RoutineTimeBasis;
  value: string;
}

interface TimezoneGroup {
  items: readonly TimezoneOption[];
  label: string | null;
  value: string;
}

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
  const locale = getLocale();
  const currentTimezone = currentSystemTimezone();
  const timezones = useMemo(() => supportedTimezones(), []);
  const groups = useMemo(
    () =>
      timezoneGroups({
        currentTimezone,
        locale,
        timezones,
        value,
      }),
    [currentTimezone, locale, timezones, value],
  );
  const selectedOption = useMemo(
    () =>
      groups
        .flatMap((group) => group.items)
        .find((option) => sameTimeBasis(option.timeBasis, value)) ??
      timezoneOption(value, locale),
    [groups, locale, value],
  );

  return (
    <Combobox
      items={groups}
      value={selectedOption}
      limit={MAX_VISIBLE_TIMEZONES}
      autoHighlight
      itemToStringLabel={(option: TimezoneOption) => option.label}
      itemToStringValue={(option: TimezoneOption) => option.value}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      filter={(option: TimezoneOption, query) =>
        option.searchValue.includes(query.trim().toLocaleLowerCase(locale))
      }
      onValueChange={(option) => {
        if (option) onChange(option.timeBasis);
      }}
    >
      <ComboboxInput
        id={id}
        aria-label={m.routines_timezone_label()}
        aria-invalid={invalid}
        placeholder={m.routines_timezone_search()}
        className="w-full"
        data-routine-create-focus="trigger"
      />
      <ComboboxContent>
        <ComboboxEmpty>{m.routines_timezone_empty()}</ComboboxEmpty>
        <ComboboxList>
          {(group: TimezoneGroup, index) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.label ? (
                <ComboboxLabel>{group.label}</ComboboxLabel>
              ) : null}
              <ComboboxCollection>
                {(option: TimezoneOption) => (
                  <ComboboxItem key={option.value} value={option}>
                    {option.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
              {index < groups.length - 1 ? <ComboboxSeparator /> : null}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function timezoneGroups({
  currentTimezone,
  locale,
  timezones,
  value,
}: {
  currentTimezone: string | null;
  locale: string;
  timezones: readonly string[];
  value: RoutineTimeBasis;
}): readonly TimezoneGroup[] {
  const localOption = timezoneOption({ mode: "local" }, locale);
  const suggestedOptions = [localOption];
  if (currentTimezone) {
    suggestedOptions.push(
      timezoneOption({ mode: "fixed", timezone: currentTimezone }, locale),
    );
  }
  if (
    value.mode === "fixed" &&
    value.timezone !== currentTimezone &&
    !timezones.includes(value.timezone)
  ) {
    suggestedOptions.push(timezoneOption(value, locale));
  }

  return [
    { value: "suggested", label: null, items: suggestedOptions },
    ...groupRoutineTimezones({ currentTimezone, timezones }).map((group) => ({
      value: group.region,
      label: timezoneRegionLabel(group.region),
      items: group.timezones.map((timezone) =>
        timezoneOption({ mode: "fixed", timezone }, locale),
      ),
    })),
  ];
}

function timezoneOption(
  timeBasis: RoutineTimeBasis,
  locale: string,
): TimezoneOption {
  if (timeBasis.mode === "local") {
    const label = m.routines_timezone_local();
    return {
      label,
      searchValue: label.toLocaleLowerCase(locale),
      timeBasis,
      value: "local",
    };
  }
  const label = timezoneDisplayLabel(timeBasis.timezone, locale);
  return {
    label,
    searchValue: `${label} ${timeBasis.timezone}`.toLocaleLowerCase(locale),
    timeBasis,
    value: `fixed:${timeBasis.timezone}`,
  };
}

function timezoneRegionLabel(region: RoutineTimezoneRegion) {
  const labels: Record<RoutineTimezoneRegion, () => string> = {
    africa: m.routines_timezone_region_africa,
    americas: m.routines_timezone_region_americas,
    asia: m.routines_timezone_region_asia,
    europe: m.routines_timezone_region_europe,
    oceania: m.routines_timezone_region_oceania,
    other: m.routines_timezone_region_other,
  };
  return labels[region]();
}

function sameTimeBasis(left: RoutineTimeBasis, right: RoutineTimeBasis) {
  return (
    left.mode === right.mode &&
    (left.mode === "local" ||
      (right.mode === "fixed" && left.timezone === right.timezone))
  );
}
