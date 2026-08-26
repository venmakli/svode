import type { RoutineTimeBasis } from "./types";

const FALLBACK_TIMEZONES = ["UTC"] as const;
const TIMEZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
export const MAX_VISIBLE_TIMEZONES = 100;

export type RoutineTimezoneRegion =
  | "africa"
  | "americas"
  | "asia"
  | "europe"
  | "oceania"
  | "other";

export interface RoutineTimezoneGroupProjection {
  region: RoutineTimezoneRegion;
  timezones: readonly string[];
}

const TIMEZONE_REGION_ORDER: readonly RoutineTimezoneRegion[] = [
  "americas",
  "europe",
  "africa",
  "asia",
  "oceania",
  "other",
];

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

export function groupRoutineTimezones({
  currentTimezone,
  timezones,
}: {
  currentTimezone: string | null;
  timezones: readonly string[];
}): readonly RoutineTimezoneGroupProjection[] {
  const groups = new Map<RoutineTimezoneRegion, string[]>();
  for (const timezone of timezones) {
    if (timezone === currentTimezone) continue;
    const region = timezoneRegion(timezone);
    const values = groups.get(region) ?? [];
    values.push(timezone);
    groups.set(region, values);
  }

  const currentRegion = currentTimezone
    ? timezoneRegion(currentTimezone)
    : null;
  const orderedRegions = currentRegion
    ? [
        currentRegion,
        ...TIMEZONE_REGION_ORDER.filter((region) => region !== currentRegion),
      ]
    : TIMEZONE_REGION_ORDER;

  return orderedRegions.flatMap((region) => {
    const values = groups.get(region);
    return values ? [{ region, timezones: values }] : [];
  });
}

export function matchesRoutineTimezone(
  timezone: string,
  query: string,
  locale: string,
  at: Date,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return true;
  return `${timezoneDisplayLabel(timezone, locale, at)} ${timezoneCityLabel(timezone)} ${timezone}`
    .toLocaleLowerCase(locale)
    .includes(normalizedQuery);
}

function timezoneRegion(timezone: string): RoutineTimezoneRegion {
  const prefix = timezone.split("/")[0];
  if (prefix === "Africa") return "africa";
  if (prefix === "America") return "americas";
  if (prefix === "Asia") return "asia";
  if (prefix === "Europe") return "europe";
  if (["Australia", "Pacific"].includes(prefix)) return "oceania";
  return "other";
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
