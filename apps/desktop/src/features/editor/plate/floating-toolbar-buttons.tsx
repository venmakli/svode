import { FloatingToolbarButtons as RegistryFloatingToolbarButtons } from "@/components/ui/floating-toolbar-buttons";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { editorFormattingShortcuts } from "../model/shortcuts";
import * as m from "@/paraglide/messages.js";

export function FloatingToolbarButtons() {
  return (
    <RegistryFloatingToolbarButtons
      labels={{
        bold: `${editorFormattingShortcuts.bold.label()} (${shortcutLabel(editorFormattingShortcuts.bold)})`,
        italic: `${editorFormattingShortcuts.italic.label()} (${shortcutLabel(editorFormattingShortcuts.italic)})`,
        underline: `${editorFormattingShortcuts.underline.label()} (${shortcutLabel(editorFormattingShortcuts.underline)})`,
        strikethrough: `${editorFormattingShortcuts.strikethrough.label()} (${shortcutLabel(editorFormattingShortcuts.strikethrough)})`,
        code: `${editorFormattingShortcuts.code.label()} (${shortcutLabel(editorFormattingShortcuts.code)})`,
        link: `${editorFormattingShortcuts.link.label()} (${shortcutLabel(editorFormattingShortcuts.link)})`,
        turnInto: m.editor_format_turn_into(),
        more: m.editor_format_more(),
      }}
    />
  );
}
