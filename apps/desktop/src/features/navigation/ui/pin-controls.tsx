import { Pin, PinOff, SquarePlus } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useKeepInNow } from "../hooks/use-keep-in-now";
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

/** "Keep in Now" item of an object menu; hidden once it is pinned or kept. */
export function KeepMenuItem({ item }: { item: NavigationItem | null }) {
  const { available, pending, keep } = useKeepInNow(item);
  if (!available) return null;
  return (
    <DropdownMenuItem disabled={pending} onSelect={keep}>
      <SquarePlus />
      {m.navigation_keep()}
    </DropdownMenuItem>
  );
}

/** The navigation items of an object menu: Pin/Unpin and Keep in Now. */
export function NavigationMenuItems({ item }: { item: NavigationItem | null }) {
  return (
    <>
      <PinMenuItem item={item} />
      <KeepMenuItem item={item} />
    </>
  );
}
