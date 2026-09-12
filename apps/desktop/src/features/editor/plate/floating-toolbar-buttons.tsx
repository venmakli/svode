import { FloatingToolbarButtons as RegistryFloatingToolbarButtons } from "@/components/ui/floating-toolbar-buttons";
import { formatModShortcut } from "@/shared/lib/keyboard-shortcuts";
import * as m from "@/paraglide/messages.js";

export function FloatingToolbarButtons() {
  return (
    <RegistryFloatingToolbarButtons
      labels={{
        bold: `${m.editor_format_bold()} (${formatModShortcut("B")})`,
        italic: `${m.editor_format_italic()} (${formatModShortcut("I")})`,
        underline: `${m.editor_format_underline()} (${formatModShortcut("U")})`,
        strikethrough: `${m.editor_format_strikethrough()} (${formatModShortcut("X", true)})`,
        code: `${m.editor_format_code()} (${formatModShortcut("E")})`,
        link: `${m.editor_format_link()} (${formatModShortcut("K")})`,
        turnInto: m.editor_format_turn_into(),
        more: m.editor_format_more(),
      }}
    />
  );
}
