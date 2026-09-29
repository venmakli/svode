import {
  CircleCheck,
  CircleHelp,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareWarning,
  OctagonX,
  Square,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { hasActionableWait, type AgentSession } from "../model";
import * as m from "@/paraglide/messages.js";

interface SessionStatusMarkerProps {
  session: AgentSession;
  className?: string;
}

export function SessionStatusMarker({
  session,
  className,
}: SessionStatusMarkerProps) {
  const label = statusMarkerLabel(session);
  const waitKind = actionableWaitKind(session);
  const size = cn("size-3", className);

  if (waitKind === "approval") {
    return (
      <MessageSquareWarning
        aria-label={label}
        className={cn(size, "text-warning")}
      />
    );
  }

  if (waitKind === "input") {
    return (
      <MessageCircleQuestion
        aria-label={label}
        className={cn(size, "text-warning")}
      />
    );
  }

  if (session.status === "active") {
    return (
      <LoaderCircle
        aria-label={label}
        className={cn(size, "animate-spin text-foreground")}
      />
    );
  }

  if (session.status === "failed") {
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

  if (session.status === "stopped") {
    return (
      <Square
        aria-label={label}
        className={cn(size, "text-muted-foreground")}
      />
    );
  }

  if (session.status === "unknown") {
    return (
      <CircleHelp
        aria-label={label}
        className={cn(size, "text-muted-foreground")}
      />
    );
  }

  return (
    <CircleCheck
      aria-label={label}
      className={cn(size, "text-muted-foreground")}
    />
  );
}

export function statusLabel(session: AgentSession): string {
  const waitKind = actionableWaitKind(session);
  if (waitKind === "approval") return m.sessions_status_waiting_approval();
  if (hasActionableWait(session)) return m.sessions_status_waiting_input();
  if (session.status === "active") return m.sessions_status_active();
  if (session.status === "failed") return m.sessions_status_failed();
  if (session.status === "stopped") return m.sessions_status_stopped();
  if (session.status === "unknown") return m.sessions_status_unknown();
  return m.sessions_status_done();
}

export function statusMarkerLabel(session: AgentSession): string {
  if (
    session.runtime?.ptyId &&
    !hasActionableWait(session) &&
    session.status !== "active" &&
    session.status !== "failed"
  ) {
    return m.sessions_status_terminal_open();
  }

  return statusLabel(session);
}

function actionableWaitKind(
  session: AgentSession,
): "approval" | "input" | null {
  if (!hasActionableWait(session)) return null;
  if (session.activeFlags?.includes("waitingOnApproval")) return "approval";
  if (session.activeFlags?.includes("waitingOnUserInput")) return "input";
  return null;
}
