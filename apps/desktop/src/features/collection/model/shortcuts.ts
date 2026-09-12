import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

export const collectionShortcuts = [
  {
    id: "create-entry",
    label: m.shortcuts_create_entry,
    keys: [["Mod", "N"]],
    context: m.shortcuts_collection_write,
  },
  {
    id: "select-view",
    label: m.shortcuts_select_view,
    keys: [["Mod", "1\u20269"]],
  },
  {
    id: "previous-view",
    label: m.shortcuts_previous_view,
    keys: [["Mod", "ArrowLeft"]],
  },
  {
    id: "next-view",
    label: m.shortcuts_next_view,
    keys: [["Mod", "ArrowRight"]],
  },
  {
    id: "move-view-left",
    label: m.shortcuts_move_view_left,
    keys: [["Mod", "Shift", "ArrowLeft"]],
    context: m.shortcuts_collection_write,
  },
  {
    id: "move-view-right",
    label: m.shortcuts_move_view_right,
    keys: [["Mod", "Shift", "ArrowRight"]],
    context: m.shortcuts_collection_write,
  },
] satisfies readonly ShortcutDescription[];
