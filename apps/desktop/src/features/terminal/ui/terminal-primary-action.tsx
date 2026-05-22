import { SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import type { TerminalTarget } from "@/features/terminal/model/types";
import * as m from "@/paraglide/messages.js";

interface TerminalPrimaryActionProps {
  target: TerminalTarget | null;
}

export function TerminalPrimaryAction({ target }: TerminalPrimaryActionProps) {
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const togglePanel = useTerminalStore((state) => state.togglePanel);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={panelOpen ? "secondary" : "outline"}
          size="icon-sm"
          aria-label={m.terminal_toggle()}
          disabled={!target}
          onClick={() => void togglePanel(target)}
        >
          <SquareTerminal />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{m.terminal_toggle()}</TooltipContent>
    </Tooltip>
  );
}
