import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { useTerminalPaneRuntime } from "@/features/terminal/hooks/use-terminal-pane-runtime";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import type { TerminalTab } from "@/features/terminal/model/types";
import * as m from "@/paraglide/messages.js";
import { TerminalDropOverlay } from "./terminal-drop-overlay";

interface TerminalPaneProps {
  tab: TerminalTab;
  active: boolean;
  panelOpen: boolean;
}

export function TerminalPane({ tab, active, panelOpen }: TerminalPaneProps) {
  const closeTab = useTerminalStore((state) => state.closeTab);
  const { containerRef, terminalVisible, dropOverlay, dropHandlers } =
    useTerminalPaneRuntime({
      tab,
      active,
      panelOpen,
    });

  return (
    <div className={cn("absolute inset-0", active ? "block" : "hidden")}>
      {terminalVisible ? (
        <div className="relative h-full overflow-hidden" {...dropHandlers}>
          <div
            ref={containerRef}
            className="h-full overflow-hidden px-2 py-1"
          />
          {tab.status === "exited" && (
            <div className="pointer-events-none absolute right-3 bottom-2 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
              {m.terminal_session_exited()}
            </div>
          )}
          <TerminalDropOverlay state={dropOverlay} />
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <div className="max-w-xl text-center">
            {tab.status === "exited"
              ? m.terminal_session_exited()
              : tab.error || m.terminal_spawn_error()}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void closeTab(tab.id)}
          >
            {m.terminal_close_tab()}
          </Button>
        </div>
      )}
    </div>
  );
}
