import {
  CircleCheck,
  CircleHelp,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareWarning,
  OctagonX,
  Square,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  agentSessionStatusValue,
  isAgentTurnActive,
  type AgentSession,
  type AgentSessionStatusValue,
} from "../model";
import * as m from "@/paraglide/messages.js";

/** Collection "Status" options in lifecycle order, each with its color. */
export const STATUS_OPTIONS = [
  { value: "requires_action", color: "orange" },
  { value: "running", color: "blue" },
  { value: "done", color: "green" },
  { value: "cancelled", color: "gray" },
  { value: "interrupted", color: "yellow" },
  { value: "error", color: "red" },
  { value: "unknown", color: "neutral" },
] as const satisfies readonly {
  value: AgentSessionStatusValue;
  color: string;
}[];

interface SessionStatusMarkerProps {
  session: AgentSession;
  className?: string;
}

export function SessionStatusMarker({
  session,
  className,
}: SessionStatusMarkerProps) {
  const label = statusMarkerLabel(session);
  const size = cn("size-3", className);
  const { status } = session;

  if (status.state === "requires_action") {
    const Icon =
      status.request === "permission"
        ? MessageSquareWarning
        : MessageCircleQuestion;
    return <Icon aria-label={label} className={cn(size, "text-warning")} />;
  }

  if (status.state === "running") {
    return (
      <LoaderCircle
        aria-label={label}
        className={cn(size, "animate-spin text-foreground")}
      />
    );
  }

  const value = agentSessionStatusValue(session);
  if (value === "error") {
    return (
      <OctagonX aria-label={label} className={cn(size, "text-destructive")} />
    );
  }

  if (session.runtime?.ptyId) {
    return (
      <SquareTerminal
        aria-label={label}
        className={cn(size, "text-muted-foreground")}
      />
    );
  }

  const Icon =
    value === "cancelled"
      ? Square
      : value === "interrupted"
        ? Unplug
        : value === "unknown"
          ? CircleHelp
          : CircleCheck;
  return (
    <Icon aria-label={label} className={cn(size, "text-muted-foreground")} />
  );
}

export function statusValueLabel(value: AgentSessionStatusValue): string {
  switch (value) {
    case "requires_action":
      return m.sessions_status_requires_action();
    case "running":
      return m.sessions_status_running();
    case "done":
      return m.sessions_status_done();
    case "cancelled":
      return m.sessions_status_cancelled();
    case "interrupted":
      return m.sessions_status_interrupted();
    case "error":
      return m.sessions_status_error();
    case "unknown":
      return m.sessions_status_unknown();
  }
}

/** The collection "Status" value of the session. */
export function statusLabel(session: AgentSession): string {
  return statusValueLabel(agentSessionStatusValue(session));
}

export function statusMarkerLabel(session: AgentSession): string {
  if (
    session.runtime?.ptyId &&
    !isAgentTurnActive(session) &&
    agentSessionStatusValue(session) !== "error"
  ) {
    return m.sessions_status_terminal_open();
  }

  return statusLabel(session);
}

/**
 * What the status value alone does not say: the kind of request a waiting
 * turn is blocked on, or a stop reason other than the end of the turn.
 */
export function statusQualifier(session: AgentSession): string | null {
  const { status } = session;
  if (status.state === "requires_action") {
    return status.request === "permission"
      ? m.sessions_status_request_permission()
      : m.sessions_status_request_question();
  }
  if (status.state !== "idle") return null;
  switch (status.stopReason) {
    case "max_tokens":
      return m.sessions_status_reason_max_tokens();
    case "max_turn_requests":
      return m.sessions_status_reason_max_turn_requests();
    case "refusal":
      return m.sessions_status_reason_refusal();
    default:
      return null;
  }
}

/** The status value with its qualifier, as the session header shows it. */
export function statusText(session: AgentSession): string {
  return [statusLabel(session), statusQualifier(session)]
    .filter(Boolean)
    .join(" — ");
}

/** Where the status comes from and how certain it is. */
export function statusSourceLabel(session: AgentSession): string {
  const { source, confidence } = session.status;
  if (source === "none") return m.sessions_status_source_none();
  const sourceLabel =
    source === "svode_runtime"
      ? m.sessions_status_source_svode_runtime()
      : source === "managed_pty"
        ? m.sessions_status_source_managed_pty()
        : m.sessions_status_source_native_status_reader();
  const confidenceLabel =
    confidence === "exact"
      ? m.sessions_status_confidence_exact()
      : m.sessions_status_confidence_approximate();
  return `${sourceLabel}, ${confidenceLabel}`;
}

/**
 * The tooltip line under the marker label: the status when the marker names
 * the open terminal instead, its qualifier, then its source.
 */
export function statusTooltipDetail(session: AgentSession): string {
  const label = statusLabel(session);
  return [
    statusMarkerLabel(session) === label ? null : label,
    statusQualifier(session),
    statusSourceLabel(session),
  ]
    .filter(Boolean)
    .join(" · ");
}
