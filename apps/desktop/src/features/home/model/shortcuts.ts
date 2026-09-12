import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

export const homeShortcuts = [
  {
    id: "create-project",
    label: m.shortcuts_create_project,
    keys: [["Mod", "N"]],
    context: m.shortcuts_home_context,
  },
] satisfies readonly ShortcutDescription[];
