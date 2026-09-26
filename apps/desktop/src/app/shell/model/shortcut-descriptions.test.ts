import { expect, test } from "bun:test";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { settingsShortcutGroups } from "@/app/providers/settings-shortcuts";

test("shortcut reference lists the terminal toggle as Ctrl+` on every platform", () => {
  const terminal = settingsShortcutGroups
    .flatMap((group) => group.commands)
    .find((command) => command.id === "terminal");

  expect(terminal?.label()).toBe("Show or hide terminal");
  expect(shortcutLabel(terminal!, true)).toBe("⌃`");
  expect(shortcutLabel(terminal!, false)).toBe("Ctrl+`");
});
