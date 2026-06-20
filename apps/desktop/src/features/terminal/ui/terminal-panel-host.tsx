import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import { PanelBottomClose, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useTerminalEventBridge } from "@/features/terminal/hooks/use-terminal-event-bridge";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import { useTerminalTargets } from "@/features/terminal/hooks/use-terminal-targets";
import { TerminalTargetMenu } from "./terminal-target-menu";
import { TerminalTabStrip } from "./terminal-tab-strip";
import { TerminalPane } from "./terminal-pane";
import * as m from "@/paraglide/messages.js";

export function TerminalPanelHost() {
  useTerminalEventBridge();

  const hostRef = useRef<HTMLDivElement>(null);
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const panelRatio = useTerminalStore((state) => state.panelRatio);
  const setPanelRatio = useTerminalStore((state) => state.setPanelRatio);
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const closePanel = useTerminalStore((state) => state.closePanel);
  const { projectTarget, spaceTargets } = useTerminalTargets();

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
