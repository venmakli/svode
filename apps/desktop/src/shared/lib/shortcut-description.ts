import { isMacKeyboardPlatform } from "./keyboard-shortcuts";

export interface ShortcutDescription {
  id: string;
  label: () => string;
  context?: () => string;
  keys: readonly (readonly string[])[];
  windowsKeys?: readonly (readonly string[])[];
}

export interface ShortcutGroup {
  id: string;
  label: () => string;
  context?: () => string;
  commands: readonly ShortcutDescription[];
}

export function shortcutKeys(
  command: ShortcutDescription,
  mac = isMacKeyboardPlatform(),
) {
  return !mac && command.windowsKeys ? command.windowsKeys : command.keys;
}

export function shortcutKeyName(key: string, mac: boolean): string {
  if (key === "Mod") return mac ? "Command" : "Ctrl";
  if (key === "Alt" && mac) return "Option";
  return key;
}

export function shortcutKeyGlyph(key: string, mac: boolean): string {
  const name = shortcutKeyName(key, mac);
  const glyphs: Record<string, string> = {
    Command: "⌘",
    Option: "⌥",
    Shift: "⇧",
    Enter: "↵",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return mac
    ? (glyphs[name] ?? name)
    : name === "ArrowLeft"
      ? "←"
      : name === "ArrowRight"
        ? "→"
        : name;
}

export function shortcutLabel(
  command: ShortcutDescription,
  mac = isMacKeyboardPlatform(),
): string {
  return shortcutKeys(command, mac)
    .map((keys) => {
      const ordered =
        mac && keys.includes("Mod")
          ? [
              ...keys.slice(0, -1).filter((key) => key !== "Mod"),
              "Mod",
              ...keys.slice(-1),
            ]
          : keys;
      return ordered
        .map((key) => shortcutKeyGlyph(key, mac))
        .join(mac ? "" : "+");
    })
    .join(" / ");
}
