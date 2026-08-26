import type { RoutineTimeBasis } from "./types";

const FALLBACK_TIMEZONES = ["UTC"] as const;
const TIMEZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
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

export function timezoneDisplayLabel(
  timezone: string,
  locale: string,
  at = new Date(),
) {
  if (timezone === "UTC") return "UTC";
  const offset = timezoneNamePart(timezone, locale, "longOffset", at);
  if (!offset) return timezone;
  const location = localizedTimezoneLocation(timezone, locale, at);
  return `${location} — ${offset}`;
}

export function routineTimeBasisIdentity(timeBasis: RoutineTimeBasis) {
  return timeBasis.mode === "local" ? "local" : `fixed:${timeBasis.timezone}`;
}

export function projectRoutineTimezoneOptions({
  currentTimezone,
  localSearchText,
  locale,
  query,
  referenceDate,
  timezones,
}: {
  currentTimezone: string | null;
  localSearchText: string;
  locale: string;
  query: string;
  referenceDate?: Date;
  timezones: readonly string[];
}): RoutineTimezoneOptionProjection {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const at = referenceDate ?? new Date();
  return {
    fixedTimezones: timezones
      .filter(
        (timezone) =>
          timezone !== currentTimezone &&
          matchesTimezone(timezone, normalizedQuery, locale, at),
      )
      .slice(0, MAX_VISIBLE_TIMEZONES),
    showCurrent:
      currentTimezone !== null &&
      matchesTimezone(currentTimezone, normalizedQuery, locale, at),
    showLocal:
      !normalizedQuery ||
      localSearchText.toLocaleLowerCase().includes(normalizedQuery),
  };
}

function matchesTimezone(
  timezone: string,
  query: string,
  locale: string,
  at: Date,
) {
  if (!query) return true;
  return `${timezoneDisplayLabel(timezone, locale, at)} ${timezoneCityLabel(timezone)} ${timezone}`
    .toLocaleLowerCase()
    .includes(query);
}

function localizedTimezoneLocation(timezone: string, locale: string, at: Date) {
  if (!locale.toLocaleLowerCase().startsWith("ru")) {
    return timezoneCityLabel(timezone);
  }
  const localized = timezoneNamePart(timezone, locale, "shortGeneric", at);
  return localized && !/^(?:GMT|UTC)(?:[+-]|$)/i.test(localized)
    ? localized
    : timezoneCityLabel(timezone);
}

function timezoneNamePart(
  timezone: string,
  locale: string,
  timeZoneName: "longOffset" | "shortGeneric",
  at: Date,
) {
  try {
    const key = `${locale}:${timezone}:${timeZoneName}`;
    let formatter = TIMEZONE_FORMATTERS.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        timeZoneName,
      });
      TIMEZONE_FORMATTERS.set(key, formatter);
    }
    return formatter
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}
