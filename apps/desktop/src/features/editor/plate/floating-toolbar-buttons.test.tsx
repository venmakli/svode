import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createPlateEditor, Plate } from "platejs/react";
import { LinkPlugin } from "@platejs/link/react";
import { BasicMarksKit } from "@/components/editor/plugins/basic-marks-kit";
import { Toolbar } from "@/components/ui/toolbar";
import { setLocale } from "@/paraglide/runtime";
import { FloatingToolbarButtons } from "./floating-toolbar-buttons";

test("active formatting hints match installed bindings in both locales and platforms", () => {
  const editor = createPlateEditor({ plugins: [...BasicMarksKit, LinkPlugin] });
  const bindings = [
    ["bold", [["Mod", "b"]]],
    ["italic", [["Mod", "i"]]],
    ["underline", [["Mod", "u"]]],
    ["strikethrough", "mod+shift+x"],
    ["code", "mod+e"],
  ] as const;
  for (const [key, keys] of bindings) {
    expect(editor.getPlugin({ key }).shortcuts.toggle?.keys).toEqual(keys);
  }
  expect(editor.getOptions(LinkPlugin).triggerFloatingLinkHotkeys).toBe(
    "meta+k, ctrl+k",
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const mac of [true, false]) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { platform: mac ? "MacIntel" : "Win32", userAgent: "" },
      });
      for (const locale of ["en", "ru"] as const) {
        setLocale(locale, { reload: false });
        const html = renderToStaticMarkup(
          <Plate editor={editor}>
            <Toolbar>
              <FloatingToolbarButtons />
            </Toolbar>
          </Plate>,
        );
        contains(
          html,
          `${locale === "en" ? "Strikethrough" : "Зачёркнутый"} (${mac ? "⇧⌘X" : "Ctrl+Shift+X"})`,
        );
        for (const key of ["B", "I", "U", "E", "K"]) {
          contains(html, mac ? `⌘${key}` : `Ctrl+${key}`);
        }
        contains(
          html,
          locale === "en" ? "More formatting" : "Дополнительное форматирование",
        );
        excludes(html, "⇧+M");
        excludes(html, "Highlighter");
      }
    }
    const html = renderToStaticMarkup(
      <Plate editor={editor} readOnly>
        <Toolbar>
          <FloatingToolbarButtons />
        </Toolbar>
      </Plate>,
    );
    excludes(html, "aria-label=");
  } finally {
    setLocale("en", { reload: false });
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

function contains(html: string, value: string) {
  expect(html.includes(value)).toBe(true);
}
function excludes(html: string, value: string) {
  expect(html.includes(value)).toBe(false);
}
