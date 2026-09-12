import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { setLocale } from "@/paraglide/runtime";
import * as m from "@/paraglide/messages.js";
import {
  shortcutKeys,
  type ShortcutGroup,
} from "@/shared/lib/shortcut-description";
import { editorShortcuts } from "@/features/editor";
import { collectionShortcuts } from "@/features/collection/app-shell";
import { gitSaveShortcuts } from "@/features/git/app-shell";
import { settingsShortcut } from "../model/shortcuts";
import { AppShortcutsSection } from "./app-shortcuts-section";

const settingsShortcutGroups: readonly ShortcutGroup[] = [
  {
    id: "general",
    label: m.shortcuts_general,
    commands: [
      settingsShortcut,
      {
        id: "close-window",
        label: m.shortcuts_close_window,
        keys: [["Mod", "W"]],
        windowsKeys: [["Alt", "F4"]],
      },
    ],
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
const commands = settingsShortcutGroups.flatMap((group) => group.commands);

test("shortcut rows render locale/platform names and contexts without interactive controls", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const mac of [true, false]) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { platform: mac ? "MacIntel" : "Win32", userAgent: "" },
      });
      for (const locale of ["en", "ru"] as const) {
        setLocale(locale, { reload: false });
        const dom = new JSDOM(
          renderToStaticMarkup(
            <AppShortcutsSection groups={settingsShortcutGroups} />,
          ),
        );
        const document = dom.window.document;
        expect(document.querySelectorAll("section").length).toBe(3);
        expect(document.querySelectorAll("dl > div").length).toBe(
          commands.length,
        );
        expect(
          document.querySelectorAll("button, input, select, a, [tabindex]")
            .length,
        ).toBe(0);
        expect(document.querySelector("h2")?.textContent).toBe(
          locale === "en" ? "General" : "Общие",
        );
        for (const item of commands) {
          const row = document.querySelector(`[data-shortcut="${item.id}"]`)!;
          expect(
            row.querySelector("dt")?.textContent?.includes(item.label()),
          ).toBe(true);
          expect(row.querySelectorAll('[data-slot="kbd-group"]').length).toBe(
            shortcutKeys(item, mac).length,
          );
          expect(
            row
              .querySelector(".sr-only")
              ?.textContent?.includes(
                mac ? "Command" : item.id === "close-window" ? "Alt" : "Ctrl",
              ),
          ).toBe(true);
          if (item.context)
            expect(row.textContent?.includes(item.context())).toBe(true);
        }
        const redo = document.querySelector('[data-shortcut="redo"]')!;
        expect(redo.querySelectorAll('[data-slot="kbd-group"]').length).toBe(
          mac ? 1 : 2,
        );
        expect(
          document.querySelector('[data-shortcut="close-window"] .sr-only')
            ?.textContent,
        ).toBe(mac ? "Command + W" : "Alt + F4");

        dom.window.close();
      }
    }
  } finally {
    setLocale("en", { reload: false });
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
