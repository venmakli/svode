import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

export const settingsShortcut: ShortcutDescription = {
  id: "settings",
  label: m.settings_title,
  keys: [["Mod", ","]],
  context: m.shortcuts_settings_context,
};
