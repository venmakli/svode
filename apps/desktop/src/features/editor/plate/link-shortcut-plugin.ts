import {
  LinkPlugin,
  triggerFloatingLinkEdit,
  triggerFloatingLinkInsert,
} from "@platejs/link/react";
import type { SlateEditor } from "platejs";
import { createPlatePlugin } from "platejs/react";
import { matchesPhysicalShortcut } from "@/shared/lib/keyboard-shortcuts";

/**
 * ⌘K / Ctrl+K in an editor (DF-149): the link panel when a link applies to
 * the selection — text selected within one block, or the caret in a link.
 * Otherwise the key goes on to Search. Plate's own link hotkeys are off, so
 * this is the one place that decides; a read-only field takes no link.
 */
export const LinkShortcutPlugin = createPlatePlugin({
  key: "linkShortcut",
  editOnly: true,
  handlers: {
    onKeyDown: ({ editor, event }) => {
      if (!matchesPhysicalShortcut(event.nativeEvent, "KeyK")) return false;
      if (!applyLinkShortcut(editor)) return false;
      event.preventDefault();
      return true;
    },
  },
});

function applyLinkShortcut(editor: SlateEditor): boolean {
  if (editor.getOption(LinkPlugin, "mode") === "edit") {
    return triggerFloatingLinkEdit(editor) === true;
  }
  if (!editor.selection || editor.api.isCollapsed()) return false;
  return triggerFloatingLinkInsert(editor, { focused: true }) === true;
}
