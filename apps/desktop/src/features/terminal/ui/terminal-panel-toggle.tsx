import { SquareTerminal } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { useTerminalPanelToggle } from "@/features/terminal/hooks/use-terminal-panel-toggle";
import { terminalToggleShortcut } from "@/features/terminal/model/shortcuts";
import * as m from "@/paraglide/messages.js";

/** Window header toggle of the terminal panel, pressed while it is open. */
export function TerminalPanelToggle() {
  const { panelOpen, available, toggle } = useTerminalPanelToggle();
  if (!available) return null;

  const label = `${
    panelOpen ? m.terminal_hide_panel() : m.terminal_show_panel()
  } (${shortcutLabel(terminalToggleShortcut)})`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          pressed={panelOpen}
          onPressedChange={toggle}
          aria-label={label}
          aria-keyshortcuts="Control+`"
        >
          <SquareTerminal />
        </Toggle>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
