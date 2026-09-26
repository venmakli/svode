import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

export const terminalToggleShortcut: ShortcutDescription = {
  id: "terminal",
  label: m.shortcuts_terminal,
  keys: [["Ctrl", "`"]],
  context: m.shortcuts_terminal_context,
};
