import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  matchesPhysicalShortcut,
} from "./keyboard-shortcuts";

const dom = new JSDOM();
for (const mac of [true, false]) {
  for (const [code, keys, shift] of [
    ["KeyN", ["n", "N", "т", "Т"], false],
    ["KeyP", ["p", "P", "з", "З"], false],
    ["KeyO", ["O", "o", "Щ", "щ"], true],
  ] as const) {
    test(`${mac ? "Mac" : "Windows"}: ${code} uses physical key and exact modifiers`, () => {
      for (const key of keys) {
        const init = {
          code,
          key,
          shiftKey: shift,
          metaKey: mac,
          ctrlKey: !mac,
          cancelable: true,
        };
        const event = (patch: KeyboardEventInit = {}) =>
          new dom.window.KeyboardEvent("keydown", {
            ...init,
            ...patch,
          }) as unknown as KeyboardEvent;
        expect(matchesPhysicalShortcut(event(), code, shift, mac)).toBe(true);
        for (const patch of [
          { shiftKey: !shift },
          { altKey: true },
          { metaKey: !mac },
          { ctrlKey: mac },
          { isComposing: true },
          { code: "KeyQ" },
          { code: "" },
          { keyCode: 229 },
        ])
          expect(matchesPhysicalShortcut(event(patch), code, shift, mac)).toBe(
            false,
          );
        const prevented = event();
        prevented.preventDefault();
        expect(matchesPhysicalShortcut(prevented, code, shift, mac)).toBe(
          false,
        );
        const altGraph = event();
        Object.defineProperty(altGraph, "getModifierState", {
          value: (key: string) => key === "AltGraph",
        });
        expect(matchesPhysicalShortcut(altGraph, code, shift, mac)).toBe(false);
      }
    });
  }
}
