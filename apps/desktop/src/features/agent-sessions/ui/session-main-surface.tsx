import { useEffect, useRef } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useAgentSessionSpace, useResolvedAgentSession } from "../hooks";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type { AgentSessionTarget } from "../model";
import { AgentSessionContent } from "./session-view";

/** A session as the one object of the main area. */
export function AgentSessionMainSurface({
  target,
  onOpenRoutine,
}: {
  target: AgentSessionTarget;
  onOpenRoutine(routine: RoutineLaunchLink): void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The main area opens by an explicit action, so focus moves into it.
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={surfaceRef} tabIndex={-1} className="h-full outline-none">
      <AgentSessionContent
        key={`${target.sessionId}\n${target.launchId ?? ""}`}
        target={target}
        onOpenRoutine={onOpenRoutine}
      />
    </div>
  );
}

/** Window header breadcrumbs of a session in the main area: Space → session. */
export function AgentSessionBreadcrumbs({
  target,
}: {
  target: AgentSessionTarget;
}) {
  const session = useResolvedAgentSession(target);
  const space = useAgentSessionSpace(session);
  if (!session) return null;

  return (
    <div className="min-w-0 flex-1 px-2">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm">
          {space && (
            <>
              <BreadcrumbItem className="min-w-0">
                <span className="block max-w-[220px] truncate">
                  {space.name}
                </span>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="shrink-0" />
            </>
          )}
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="block max-w-[320px] truncate">
              {session.title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
