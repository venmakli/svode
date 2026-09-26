import { SquareTerminal } from "lucide-react";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { cn } from "@/shared/lib/utils";
import { useTerminalPanelToggle } from "@/features/terminal/hooks/use-terminal-panel-toggle";
import { terminalToggleShortcut } from "@/features/terminal/model/shortcuts";
import * as m from "@/paraglide/messages.js";

export function TerminalSidebarAction() {
  const { panelOpen, available, toggle } = useTerminalPanelToggle();
  if (!available) return null;

  const label = panelOpen ? m.terminal_hide_panel() : m.terminal_show_panel();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarMenuAction
          showOnHover
          aria-label={label}
          aria-pressed={panelOpen}
          aria-keyshortcuts="Control+`"
          className={cn(
            panelOpen &&
              "bg-sidebar-accent text-sidebar-accent-foreground md:opacity-100",
          )}
          onClick={toggle}
        >
          <SquareTerminal />
        </SidebarMenuAction>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label} ({shortcutLabel(terminalToggleShortcut)})
      </TooltipContent>
    </Tooltip>
  );
}
