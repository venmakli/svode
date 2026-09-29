import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  killTerminal,
  onTerminalError,
  onTerminalExit,
  spawnTerminal,
} from "@/features/terminal/api/terminal";
import { useTerminalPaneRuntime } from "@/features/terminal/hooks/use-terminal-pane-runtime";
import { clearTerminalOutput } from "@/features/terminal/lib/output-bus";
import type { TerminalTab } from "@/features/terminal/model/types";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import { TerminalDropOverlay } from "./terminal-drop-overlay";

const DEFAULT_MANAGED_TERMINAL_COLS = 120;
const DEFAULT_MANAGED_TERMINAL_ROWS = 30;

interface ManagedTerminalSurfaceProps {
  ptyId: string;
  title?: string;
  active?: boolean;
  /** Moves focus into the terminal once it is attached. */
  autoFocus?: boolean;
  className?: string;
  containerClassName?: string;
}

interface ManagedTerminalSurfaceInstanceProps {
  ptyId: string;
  title: string;
  active: boolean;
  autoFocus: boolean;
  className?: string;
  containerClassName?: string;
}

export function ManagedTerminalSurface({
  ptyId,
  title = "Agent session",
  active = true,
  autoFocus = true,
  className,
  containerClassName,
}: ManagedTerminalSurfaceProps) {
  return (
    <ManagedTerminalSurfaceInstance
      key={ptyId}
      ptyId={ptyId}
      title={title}
      active={active}
      autoFocus={autoFocus}
      className={className}
      containerClassName={containerClassName}
    />
  );
}

export async function closeManagedTerminalSurface(ptyId: string) {
  clearTerminalOutput(ptyId);
  await killTerminal(ptyId);
}

/** Calls the listener with the pty id of every managed terminal that exits. */
export function subscribeManagedTerminalExit(
  listener: (ptyId: string) => void,
): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void onTerminalExit((event) => listener(event.ptyId))
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    })
    .catch((err) => {
      console.warn("Failed to listen to managed terminal exit:", err);
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export function spawnManagedTerminalSurface(
  cwd: string,
  mcpProjectPath?: string | null,
) {
  return spawnTerminal(
    cwd,
    DEFAULT_MANAGED_TERMINAL_COLS,
    DEFAULT_MANAGED_TERMINAL_ROWS,
    mcpProjectPath,
  );
}

function ManagedTerminalSurfaceInstance({
  ptyId,
  title,
  active,
  autoFocus,
  className,
  containerClassName,
}: ManagedTerminalSurfaceInstanceProps) {
  const [status, setStatus] = useState<TerminalTab["status"]>("ready");
  const [error, setError] = useState<string | null>(null);
  const [createdAt] = useState(() => new Date().toISOString());
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
      origin: "agent-session",
      createdAt,
    }),
    [createdAt, error, ptyId, status, title],
  );
  const { containerRef, terminalVisible, dropOverlay, dropHandlers } =
    useTerminalPaneRuntime({
      tab,
      active,
      panelOpen: active,
      autoFocus,
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
    <div
      className={cn("relative h-full overflow-hidden", className)}
      {...dropHandlers}
    >
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
          <TerminalDropOverlay state={dropOverlay} />
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
