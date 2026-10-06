import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import { terminalToggleShortcut } from "@/features/terminal";
import * as m from "@/paraglide/messages.js";

export const sidebarShortcut: ShortcutDescription = {
  id: "sidebar",
  label: m.shortcuts_sidebar,
  keys: [["Mod", "B"]],
  context: m.shortcuts_outside_input,
};

export const allProjectsShortcut: ShortcutDescription = {
  id: "home",
  label: m.shortcuts_home,
  keys: [["Mod", "0"]],
  context: m.shortcuts_all_projects_context,
};

export const shellShortcuts = [
  {
    id: "palette",
    label: m.shortcuts_palette,
    keys: [["Mod", "P"]],
    context: m.shortcuts_project_context,
  },
  {
    id: "close-content",
    label: m.shortcuts_close_content,
    keys: [["Mod", "W"]],
    context: m.shortcuts_close_content_context,
  },
  allProjectsShortcut,
  sidebarShortcut,
  terminalToggleShortcut,
  { id: "open-folder", label: m.shortcuts_open_folder, keys: [["Mod", "O"]] },
  {
    id: "close-window",
    label: m.shortcuts_close_window,
    keys: [["Mod", "W"]],
    context: m.shortcuts_native_close,
    windowsKeys: [["Alt", "F4"]],
  },
] satisfies readonly ShortcutDescription[];
