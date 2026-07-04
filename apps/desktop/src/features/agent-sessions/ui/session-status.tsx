import {
  AlertCircle,
  Check,
  CircleHelp,
  LoaderCircle,
  OctagonX,
  Square,
  SquareTerminal,
} from "lucide-react";
import { hasActionableWait, type AgentSession } from "../model";
import * as m from "@/paraglide/messages.js";

interface SessionStatusMarkerProps {
  session: AgentSession;
}

export function SessionStatusMarker({ session }: SessionStatusMarkerProps) {
  const label = statusLabel(session);

  if (hasActionableWait(session)) {
    return <AlertCircle aria-label={label} className="size-3 text-warning" />;
  }

  if (session.status === "active") {
    return (
      <LoaderCircle
        aria-label={label}
        className="size-3 animate-spin text-foreground"
      />
    );
  }

  if (session.status === "failed") {
    return <OctagonX aria-label={label} className="size-3 text-destructive" />;
  }

  if (session.runtime?.live) {
    return (
      <SquareTerminal
        aria-label={label}
        className="size-3 text-muted-foreground"
      />
    );
  }

  if (session.status === "stopped") {
    return <Square aria-label={label} className="size-3 text-muted-foreground" />;
  }

  if (session.status === "unknown") {
    return (
      <CircleHelp
        aria-label={label}
        className="size-3 text-muted-foreground"
      />
    );
  }

  return <Check aria-label={label} className="size-3 text-muted-foreground" />;
}

export function statusLabel(session: AgentSession): string {
  if (hasActionableWait(session)) return m.sessions_status_waiting();
  if (session.status === "active") return m.sessions_status_active();
  if (session.status === "failed") return m.sessions_status_failed();
  if (session.runtime?.live) return m.sessions_status_terminal_open();
  if (session.status === "stopped") return m.sessions_status_stopped();
  if (session.status === "unknown") return m.sessions_status_unknown();
  return m.sessions_status_done();
}
