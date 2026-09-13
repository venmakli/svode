import { PanelBottom, PanelRight, X } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useTerminalDrawerLayout } from "../hooks/use-terminal-drawer-layout";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useTerminalAgentSessionSync } from "@/features/terminal/hooks/use-terminal-agent-session-sync";
import { useTerminalEventBridge } from "@/features/terminal/hooks/use-terminal-event-bridge";
import { useTerminalRootLifecycle } from "@/features/terminal/hooks/use-terminal-root-lifecycle";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import { useTerminalTargets } from "@/features/terminal/hooks/use-terminal-targets";
import { TerminalTargetMenu } from "./terminal-target-menu";
import { TerminalTabStrip } from "./terminal-tab-strip";
import { TerminalPane } from "./terminal-pane";
import * as m from "@/paraglide/messages.js";

export function TerminalPanelHost() {
  useTerminalEventBridge();
  useTerminalRootLifecycle();

  const { side, ratio, toggleSide, resizeHandlers } = useTerminalDrawerLayout();
  const moveLabel =
    side === "right" ? m.terminal_move_bottom() : m.terminal_move_right();
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const closePanel = useTerminalStore((state) => state.closePanel);
  const { projectTarget, spaceTargets } = useTerminalTargets();
  useTerminalAgentSessionSync(projectTarget?.path ?? null);

  return (
    <Sheet
      open={panelOpen}
      modal={false}
      onOpenChange={(open) => {
        if (!open) closePanel();
      }}
    >
      <SheetContent
        forceMount
        side={side}
        showCloseButton={false}
        aria-describedby={undefined}
        inert={!panelOpen}
        data-terminal-drawer
        className="gap-0 rounded-xl border data-[state=closed]:hidden"
        style={{
          top: side === "right" ? "0.75rem" : "auto",
          right: "0.75rem",
          bottom: "0.75rem",
          left: side === "right" ? "auto" : "0.75rem",
          width:
            side === "right"
              ? `max(min(20rem, calc(100vw - 1.5rem)), calc((100vw - 1.5rem) * ${ratio}))`
              : "auto",
          height:
            side === "bottom"
              ? `max(min(11rem, calc(100vh - 1.5rem)), calc((100vh - 1.5rem) * ${ratio}))`
              : "auto",
          maxWidth: "calc(100vw - 1.5rem)",
          maxHeight: "calc(100vh - 1.5rem)",
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          // The header button owns its toggle; dismissing first would reopen it.
          if (
            event.target instanceof Element &&
            event.target.closest("[data-terminal-toggle]")
          ) {
            event.preventDefault();
          }
        }}
        onFocusOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <SheetTitle className="sr-only">{m.terminal_title()}</SheetTitle>
        <div
          role="separator"
          tabIndex={panelOpen ? 0 : -1}
          aria-label={m.terminal_resize()}
          aria-orientation={side === "right" ? "vertical" : "horizontal"}
          aria-valuemin={22}
          aria-valuemax={72}
          aria-valuenow={Math.round(ratio * 100)}
          className={cn(
            "absolute touch-none rounded-sm hover:bg-border focus-visible:bg-border focus-visible:outline-none",
            side === "right"
              ? "inset-y-3 -left-1 w-2 cursor-col-resize"
              : "inset-x-3 -top-1 h-2 cursor-row-resize",
          )}
          {...resizeHandlers}
        />
        <div className="flex h-10 shrink-0 items-center gap-1 rounded-t-xl border-b bg-muted/40 px-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={moveLabel}
                onClick={toggleSide}
              >
                {side === "right" ? <PanelBottom /> : <PanelRight />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{moveLabel}</TooltipContent>
          </Tooltip>
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
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {m.terminal_hide_panel()}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl bg-background">
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              panelOpen={panelOpen}
            />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
