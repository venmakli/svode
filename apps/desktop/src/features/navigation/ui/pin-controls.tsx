import { Pin, PinOff, SquarePlus } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useKeepInNow } from "../hooks/use-keep-in-now";
import { usePinToggle } from "../hooks/use-pin-toggle";
import type { NavigationItem } from "../model/keys";
import * as m from "@/paraglide/messages.js";

/** The menu primitive the items render in: a dropdown or a context menu. */
export type NavigationMenuKind = "dropdown" | "context";

const MENU_ITEM = {
  dropdown: DropdownMenuItem,
  context: ContextMenuItem,
} as const;

interface NavigationMenuItemProps {
  item: NavigationItem | null;
  menu?: NavigationMenuKind;
}

/** "Pin" / "Unpin" item of an object menu; hidden when it cannot be pinned. */
export function PinMenuItem({
  item,
  menu = "dropdown",
}: NavigationMenuItemProps) {
  const { available, pinned, pending, toggle } = usePinToggle(item);
  if (!available) return null;
  const MenuItem = MENU_ITEM[menu];
  return (
    <MenuItem disabled={pending} onSelect={toggle}>
      {pinned ? <PinOff /> : <Pin />}
      {pinned ? m.navigation_unpin() : m.navigation_pin()}
    </MenuItem>
  );
}

/** "Keep in Now" item of an object menu; hidden once it is pinned or kept. */
export function KeepMenuItem({
  item,
  menu = "dropdown",
}: NavigationMenuItemProps) {
  const { available, pending, keep } = useKeepInNow(item);
  if (!available) return null;
  const MenuItem = MENU_ITEM[menu];
  return (
    <MenuItem disabled={pending} onSelect={keep}>
      <SquarePlus />
      {m.navigation_keep()}
    </MenuItem>
  );
}

/** The navigation items of an object menu: Pin/Unpin and Keep in Now. */
export function NavigationMenuItems({
  item,
  menu = "dropdown",
}: NavigationMenuItemProps) {
  return (
    <>
      <PinMenuItem item={item} menu={menu} />
      <KeepMenuItem item={item} menu={menu} />
    </>
  );
}
