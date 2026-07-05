import { getLocale } from "@/paraglide/runtime.js";
import { hasActionableWait, type AgentSession } from "../model";
import * as m from "@/paraglide/messages.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

type AppLocale = "en" | "ru";
type CompactTimeUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

const COMPACT_TIME_SUFFIXES: Record<
  AppLocale,
  Record<CompactTimeUnit, string>
> = {
  en: {
    minute: "m",
    hour: "h",
    day: "d",
    week: "w",
    month: "m",
    year: "y",
  },
  ru: {
    minute: "м",
    hour: "ч",
    day: "д",
    week: "н",
    month: "мес",
    year: "г",
  },
};

export function sourceLabel(source: AgentSession["source"]): string {
  if (source === "claude-code") return "Claude Code";
  if (source === "codex") return "Codex";
  return m.sessions_source_unknown();
}

export function shortSessionId(session: AgentSession): string {
  return session.sourceSessionId.slice(0, 8);
}

export function scopeLabel(
  session: AgentSession,
  rootName: string | null,
  spaceNames: Map<string, string>,
): string {
  if (session.scopeKind === "space") {
    const spaceKey = session.spaceId ?? session.spacePath;
    if (spaceKey) {
      return spaceNames.get(spaceKey) ?? pathBasename(spaceKey) ?? spaceKey;
    }
  }

  return rootName ?? pathBasename(session.projectPath) ?? "Project";
}

export function sessionTimeLabel(session: AgentSession): string {
  if (hasActionableWait(session)) {
    return shortRelativeTime(session.waitingSince ?? session.lastActivityAt);
  }

  if (session.status === "active" && session.durationMs) {
    return shortDuration(session.durationMs);
  }

  if (session.runtime?.live) {
    return shortRelativeTime(
      session.runtime.lastOutputAt ?? session.lastActivityAt,
    );
  }

  return shortRelativeTime(session.lastActivityAt);
}

export function tooltipDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function commandDisplay(session: AgentSession): string | null {
  return session.resumeCommand?.display ?? null;
}

function shortRelativeTime(value: string): string {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";

  const diffMs = Math.max(0, Date.now() - then);
  return compactElapsedTime(diffMs);
}

function shortDuration(durationMs: number): string {
  return compactElapsedTime(Math.max(0, durationMs));
}

function compactElapsedTime(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) return "now";
  if (elapsedMs < HOUR_MS) {
    return compactTimeLabel(Math.floor(elapsedMs / MINUTE_MS), "minute");
  }
  if (elapsedMs < DAY_MS) {
    return compactTimeLabel(Math.floor(elapsedMs / HOUR_MS), "hour");
  }
  if (elapsedMs < WEEK_MS) {
    return compactTimeLabel(Math.floor(elapsedMs / DAY_MS), "day");
  }
  if (elapsedMs < MONTH_MS) {
    return compactTimeLabel(Math.floor(elapsedMs / WEEK_MS), "week");
  }
  if (elapsedMs < YEAR_MS) {
    return compactTimeLabel(Math.floor(elapsedMs / MONTH_MS), "month");
  }
  return compactTimeLabel(Math.floor(elapsedMs / YEAR_MS), "year");
}

function compactTimeLabel(value: number, unit: CompactTimeUnit): string {
  const locale = getLocale() as AppLocale;
  return `${value}${COMPACT_TIME_SUFFIXES[locale][unit]}`;
}

function pathBasename(path: string | undefined): string | null {
  if (!path) return null;
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}
