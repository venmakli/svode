import { Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePinToggle } from "../hooks/use-pin-toggle";
import type { NavigationItem } from "../model/keys";
import * as m from "@/paraglide/messages.js";

/** "Pin" / "Unpin" item of an object menu; hidden when it cannot be pinned. */
export function PinMenuItem({ item }: { item: NavigationItem | null }) {
  const { available, pinned, pending, toggle } = usePinToggle(item);
  if (!available) return null;
  return (
    <DropdownMenuItem disabled={pending} onSelect={toggle}>
      {pinned ? <PinOff /> : <Pin />}
      {pinned ? m.navigation_unpin() : m.navigation_pin()}
    </DropdownMenuItem>
  );
}

/** Pin toggle for object headers without a menu, such as attachment viewers. */
export function PinToggleButton({ item }: { item: NavigationItem | null }) {
  const { available, pinned, pending, toggle } = usePinToggle(item);
  if (!available) return null;
  const label = pinned ? m.navigation_unpin() : m.navigation_pin();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pinned}
          disabled={pending}
          onClick={toggle}
        >
          {pinned ? <PinOff /> : <Pin />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
