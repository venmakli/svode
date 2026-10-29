import { getLocale } from "@/paraglide/runtime.js";
import {
  isAgentSessionInScope,
  requiresUserAction,
  type AgentSession,
  type AgentSessionScopeGroup,
  type DraftSpaceChoice,
} from "../model";

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

/**
 * The Space or project the row under a chat's composer shows: the same
 * icon and name in a new session's draft and in the session (DF-230).
 */
export interface ScopeMark {
  kind: "project" | "space";
  name: string;
  /** Emoji of the Space or project; without it the kind's icon. */
  icon: string | null;
}

/** The mark of a session's scope; an unresolved Space keeps its kind. */
export function sessionScopeMark(
  session: AgentSession,
  scopes: readonly AgentSessionScopeGroup[],
  rootName: string | null,
  spaceNames: Map<string, string>,
): ScopeMark {
  const name = scopeLabel(session, rootName, spaceNames);
  const inSpace =
    session.scopeKind === "space" &&
    Boolean(session.spaceId ?? session.spacePath);
  const scope = scopes.find((candidate) =>
    isAgentSessionInScope(session, candidate),
  );
  return {
    kind: inSpace ? "space" : "project",
    name,
    icon: scope?.icon || null,
  };
}

/**
 * The mark of a draft's Space: its choice, or, before the choices load or
 * after the Space left them, the kind by the project root and the last
 * segment of the path, as `scopeLabel` names it.
 */
export function draftScopeMark(
  spacePath: string,
  choices: readonly DraftSpaceChoice[],
  rootPath: string | null,
): ScopeMark {
  const choice = choices.find((candidate) => candidate.path === spacePath);
  if (choice) {
    return { kind: choice.kind, name: choice.name, icon: choice.icon || null };
  }
  return {
    kind: spacePath === rootPath ? "project" : "space",
    name: pathBasename(spacePath) ?? spacePath,
    icon: null,
  };
}

export function sessionTimeLabel(session: AgentSession): string {
  if (requiresUserAction(session)) {
    return shortRelativeTime(session.waitingSince ?? session.lastActivityAt);
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
