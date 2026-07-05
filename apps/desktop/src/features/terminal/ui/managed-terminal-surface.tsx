import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  killTerminal,
  onTerminalError,
  onTerminalExit,
} from "@/features/terminal/api/terminal";
import { useTerminalPaneRuntime } from "@/features/terminal/hooks/use-terminal-pane-runtime";
import { clearTerminalOutput } from "@/features/terminal/lib/output-bus";
import type { TerminalTab } from "@/features/terminal/model/types";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

interface ManagedTerminalSurfaceProps {
  ptyId: string;
  title?: string;
  active?: boolean;
  className?: string;
  containerClassName?: string;
}

interface ManagedTerminalSurfaceInstanceProps {
  ptyId: string;
  title: string;
  active: boolean;
  className?: string;
  containerClassName?: string;
}

export function ManagedTerminalSurface({
  ptyId,
  title = "Agent session",
  active = true,
  className,
  containerClassName,
}: ManagedTerminalSurfaceProps) {
  return (
    <ManagedTerminalSurfaceInstance
      key={ptyId}
      ptyId={ptyId}
      title={title}
      active={active}
      className={className}
      containerClassName={containerClassName}
    />
  );
}

export async function closeManagedTerminalSurface(ptyId: string) {
  clearTerminalOutput(ptyId);
  await killTerminal(ptyId);
}

function ManagedTerminalSurfaceInstance({
  ptyId,
  title,
  active,
  className,
  containerClassName,
}: ManagedTerminalSurfaceInstanceProps) {
  const [status, setStatus] = useState<TerminalTab["status"]>("ready");
  const [error, setError] = useState<string | null>(null);
  const tab = useMemo<TerminalTab>(
    () => ({
      id: ptyId,
      title,
      cwd: "",
      scope: "project",
      scopeId: "agent-session",
      ptyId,
      status,
      error,
    }),
    [error, ptyId, status, title],
  );
  const { containerRef, terminalVisible } = useTerminalPaneRuntime({
    tab,
    active,
    panelOpen: active,
  });

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    function addUnlistener(unlisten: () => void) {
      if (cancelled) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    }

    void onTerminalExit((event) => {
      if (event.ptyId === ptyId) setStatus("exited");
    })
      .then(addUnlistener)
      .catch((err) => {
        console.warn("Failed to listen to managed terminal exit:", err);
      });

    void onTerminalError((event) => {
      if (event.ptyId !== ptyId) return;
      setStatus("error");
      setError(event.message);
    })
      .then(addUnlistener)
      .catch((err) => {
        console.warn("Failed to listen to managed terminal error:", err);
      });

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [ptyId]);

  return (
    <div className={cn("relative h-full overflow-hidden", className)}>
      {terminalVisible ? (
        <>
          <div
            ref={containerRef}
            className={cn(
              "h-full overflow-hidden px-2 pt-1 pb-1",
              containerClassName,
            )}
          />
          {status === "exited" && (
            <div className="pointer-events-none absolute right-3 bottom-2 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
              {m.terminal_session_exited()}
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <div className="max-w-xl text-center">
            {error || m.terminal_spawn_error()}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void closeManagedTerminalSurface(ptyId)}
          >
            {m.terminal_close_tab()}
          </Button>
        </div>
      )}
    </div>
  );
}
