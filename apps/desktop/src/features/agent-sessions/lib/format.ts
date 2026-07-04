import { getLocale } from "@/paraglide/runtime.js";
import { hasActionableWait, type AgentSession } from "../model";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function sourceLabel(source: AgentSession["source"]): string {
  return source === "claude-code" ? "Claude Code" : "Codex";
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
  if (diffMs < MINUTE_MS) return "now";
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h`;
  if (diffMs < 7 * DAY_MS) return `${Math.floor(diffMs / DAY_MS)}d`;

  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
  }).format(new Date(then));
}

function shortDuration(durationMs: number): string {
  if (durationMs < MINUTE_MS) return "now";
  if (durationMs < HOUR_MS) return `${Math.floor(durationMs / MINUTE_MS)}m`;
  if (durationMs < DAY_MS) return `${Math.floor(durationMs / HOUR_MS)}h`;
  return `${Math.floor(durationMs / DAY_MS)}d`;
}

function pathBasename(path: string | undefined): string | null {
  if (!path) return null;
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}
