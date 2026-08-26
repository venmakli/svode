import type { RoutineTimeBasis } from "./types";

const FALLBACK_TIMEZONES = ["UTC"] as const;
export const MAX_VISIBLE_TIMEZONES = 100;

export interface RoutineTimezoneOptionProjection {
  fixedTimezones: readonly string[];
  showCurrent: boolean;
  showLocal: boolean;
}

export function currentSystemTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function supportedTimezones(): readonly string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  try {
    const values = supportedValuesOf?.("timeZone") ?? [];
    if (values.length === 0) return FALLBACK_TIMEZONES;
    return values.includes("UTC") ? values : ["UTC", ...values];
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

export function isValidTimezone(timezone: string) {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function timezoneCityLabel(timezone: string) {
  return (timezone.split("/").at(-1) ?? timezone).replaceAll("_", " ");
}

export function routineTimeBasisIdentity(timeBasis: RoutineTimeBasis) {
  return timeBasis.mode === "local" ? "local" : `fixed:${timeBasis.timezone}`;
}

export function projectRoutineTimezoneOptions({
  currentTimezone,
  localSearchText,
  query,
  timezones,
}: {
  currentTimezone: string | null;
  localSearchText: string;
  query: string;
  timezones: readonly string[];
}): RoutineTimezoneOptionProjection {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return {
    fixedTimezones: timezones
      .filter(
        (timezone) =>
          timezone !== currentTimezone &&
          matchesTimezone(timezone, normalizedQuery),
      )
      .slice(0, MAX_VISIBLE_TIMEZONES),
    showCurrent:
      currentTimezone !== null &&
      matchesTimezone(currentTimezone, normalizedQuery),
    showLocal:
      !normalizedQuery ||
      localSearchText.toLocaleLowerCase().includes(normalizedQuery),
  };
}

function matchesTimezone(timezone: string, query: string) {
  if (!query) return true;
  return `${timezoneCityLabel(timezone)} ${timezone}`
    .toLocaleLowerCase()
    .includes(query);
}
