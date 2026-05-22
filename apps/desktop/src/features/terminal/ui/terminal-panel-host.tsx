import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef } from "react";
import { PanelBottomClose, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSpaceStore } from "@/stores/space";
import {
  onTerminalError,
  onTerminalExit,
  onTerminalOutput,
} from "@/features/terminal/api/terminal";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import {
  buildProjectTerminalTarget,
  buildSpaceTerminalTargets,
} from "@/features/terminal/lib/targets";
import { publishTerminalOutput } from "@/features/terminal/lib/output-bus";
import { TerminalTargetMenu } from "./terminal-target-menu";
import { TerminalTabStrip } from "./terminal-tab-strip";
import { TerminalPane } from "./terminal-pane";
import * as m from "@/paraglide/messages.js";

export function TerminalPanelHost() {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const panelRatio = useTerminalStore((state) => state.panelRatio);
  const setPanelRatio = useTerminalStore((state) => state.setPanelRatio);
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const closePanel = useTerminalStore((state) => state.closePanel);
  const markExited = useTerminalStore((state) => state.markExited);
  const markError = useTerminalStore((state) => state.markError);
  const { activeRootId, activeRootName, activeRootPath, spaces } =
    useSpaceStore();

  const projectTarget = useMemo(
    () =>
      buildProjectTerminalTarget({
        id: activeRootId,
        name: activeRootName,
        path: activeRootPath,
      }),
    [activeRootId, activeRootName, activeRootPath],
  );
  const spaceTargets = useMemo(
    () => buildSpaceTerminalTargets(spaces),
    [spaces],
  );

  useEffect(() => {
    let cancelled = false;
    let unlistenExit: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let unlistenOutput: (() => void) | null = null;

    onTerminalOutput((event) => {
      publishTerminalOutput(event.ptyId, event.data);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenOutput = unlisten;
    });
    onTerminalExit((event) => markExited(event.ptyId)).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenExit = unlisten;
    });
    onTerminalError((event) => markError(event.ptyId, event.message)).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else unlistenError = unlisten;
      },
    );

    return () => {
      cancelled = true;
      unlistenOutput?.();
      unlistenExit?.();
      unlistenError?.();
    };
  }, [markError, markExited]);

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (!panelOpen) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const parentRect = parent.getBoundingClientRect();

    function handlePointerMove(moveEvent: globalThis.PointerEvent) {
      const nextHeight = parentRect.bottom - moveEvent.clientY;
      setPanelRatio(nextHeight / parentRect.height);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <div
      ref={hostRef}
      className={cn(
        "shrink-0 overflow-hidden border-t bg-card transition-[height]",
        panelOpen ? "min-h-44" : "h-0 min-h-0 border-t-0",
      )}
      style={{ height: panelOpen ? `${panelRatio * 100}%` : 0 }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        className="flex h-1 cursor-row-resize items-center justify-center bg-border/60"
        onPointerDown={handleResizeStart}
      />
      <div className="flex h-9 items-center gap-1 border-b bg-muted/40">
        <div className="flex h-9 shrink-0 items-center pl-3 pr-1 text-muted-foreground">
          <SquareTerminal className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <TerminalTabStrip tabs={tabs} activeTabId={activeTabId} />
          <TerminalTargetMenu project={projectTarget} spaces={spaceTargets} />
          <div className="min-w-2 flex-1" />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.terminal_hide_panel()}
              onClick={closePanel}
            >
              <PanelBottomClose />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{m.terminal_hide_panel()}</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative h-[calc(100%-2.5rem)] overflow-hidden bg-background">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            panelOpen={panelOpen}
          />
        ))}
      </div>
    </div>
  );
}
