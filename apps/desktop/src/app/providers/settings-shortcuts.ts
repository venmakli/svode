import type { ShortcutGroup } from "@/shared/lib/shortcut-description";
import { editorShortcuts } from "@/features/editor";
import { collectionShortcuts } from "@/features/collection/app-shell";
import { gitSaveShortcuts } from "@/features/git/app-shell";
import { homeShortcuts } from "@/features/home";
import { settingsShortcut } from "@/features/settings";
import { shellShortcuts } from "../shell/model/shortcut-descriptions";
import * as m from "@/paraglide/messages.js";

export const settingsShortcutGroups: readonly ShortcutGroup[] = [
  {
    id: "general",
    label: m.shortcuts_general,
    commands: [settingsShortcut, ...shellShortcuts, ...homeShortcuts],
  },
  {
    id: "editor",
    label: m.shortcuts_editor,
    context: m.shortcuts_editor_context,
    commands: [...gitSaveShortcuts, ...editorShortcuts],
  },
  {
    id: "collections",
    label: m.shortcuts_collections,
    context: m.shortcuts_collection_context,
    commands: collectionShortcuts,
  },
];
