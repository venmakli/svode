import {
  shortcutLabel,
  type ShortcutDescription,
} from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

/**
 * Starts and stops dictation as ■ while focus is in a composer (`06`).
 * Free across the app: Mod+M minimizes on macOS, Mod+Shift+M is unused.
 */
export const dictationShortcut: ShortcutDescription = {
  id: "dictation",
  label: m.voice_input_shortcut,
  keys: [["Mod", "Shift", "M"]],
  context: m.voice_input_shortcut_context,
};

/** The physical key of the shortcut, for `matchesPhysicalShortcut`. */
export const DICTATION_KEY_CODE = "KeyM";

export function dictationShortcutLabel(): string {
  return shortcutLabel(dictationShortcut);
}
