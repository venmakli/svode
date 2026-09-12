import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

export const saveSelfShortcut: ShortcutDescription = {
  id: "save-self",
  label: m.shortcuts_save_self,
  keys: [["Mod", "S"]],
  context: m.shortcuts_save_self_context,
};
export const saveDescendantsShortcut: ShortcutDescription = {
  id: "save-descendants",
  label: m.shortcuts_save_descendants,
  keys: [["Mod", "Shift", "S"]],
  context: m.shortcuts_save_descendants_context,
};
export const gitSaveShortcuts = [saveSelfShortcut, saveDescendantsShortcut];
