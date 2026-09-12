import { expect, test } from "bun:test";
import { createPlateEditor } from "platejs/react";
import { LinkPlugin } from "@platejs/link/react";
import { BasicMarksKit } from "@/components/editor/plugins/basic-marks-kit";
import { BasicBlocksKit } from "@/components/editor/plugins/basic-blocks-kit";
import { CodeBlockKit } from "@/components/editor/plugins/code-block-kit";
import { ExitBreakKit } from "@/components/editor/plugins/exit-break-kit";
import { shortcutKeys, shortcutLabel } from "@/shared/lib/shortcut-description";
import { settingsShortcutGroups } from "./settings-shortcuts";

const commands = settingsShortcutGroups.flatMap((group) => group.commands);
const command = (id: string) => commands.find((item) => item.id === id)!;

test("app composition contains the full active inventory", () => {
  const expectedIds = [
    "settings",
    "palette",
    "close-content",
    "home",
    "sidebar",
    "open-folder",
    "close-window",
    "create-project",
    "save-self",
    "save-descendants",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "code",
    "link",
    "highlight",
    "subscript",
    "superscript",
    "undo",
    "redo",
    "heading-1",
    "heading-2",
    "heading-3",
    "heading-4",
    "heading-5",
    "heading-6",
    "code-block",
    "quote",
    "insert-after",
    "insert-before",
    "create-entry",
    "select-view",
    "previous-view",
    "next-view",
    "move-view-left",
    "move-view-right",
  ];
  expect(commands.map((item) => item.id)).toEqual(expectedIds);
  expect(settingsShortcutGroups.map((group) => group.id)).toEqual([
    "general",
    "editor",
    "collections",
  ]);
});

test("published editor keys agree with installed active plugin bindings", () => {
  const editor = createPlateEditor({
    plugins: [
      ...BasicMarksKit,
      ...BasicBlocksKit,
      ...CodeBlockKit,
      ...ExitBreakKit,
      LinkPlugin,
    ],
  });
  for (const [id, plugin] of [
    ["bold", "bold"],
    ["italic", "italic"],
    ["underline", "underline"],
    ["strikethrough", "strikethrough"],
    ["code", "code"],
    ["highlight", "highlight"],
    ["subscript", "subscript"],
    ["superscript", "superscript"],
    ["heading-1", "h1"],
    ["heading-2", "h2"],
    ["heading-3", "h3"],
    ["heading-4", "h4"],
    ["heading-5", "h5"],
    ["heading-6", "h6"],
    ["code-block", "code_block"],
    ["quote", "blockquote"],
  ]) {
    const actual = editor.getPlugin({ key: plugin! }).shortcuts.toggle?.keys;
    const expected = command(id!).keys[0]!.map((key) =>
      key === "," ? "comma" : key === "." ? "period" : key.toLowerCase(),
    );
    expect(
      typeof actual === "string"
        ? actual.toLowerCase()
        : (actual as string[][])[0]!.map((key) => key.toLowerCase()).join("+"),
    ).toBe(expected.join("+"));
  }
  expect(editor.getOptions(LinkPlugin).triggerFloatingLinkHotkeys).toBe(
    "meta+k, ctrl+k",
  );
  expect(editor.getPlugin({ key: "exitBreak" }).shortcuts.insert?.keys).toBe(
    command("insert-after").keys[0]!.join("+").toLowerCase(),
  );
  expect(
    editor.getPlugin({ key: "exitBreak" }).shortcuts.insertBefore?.keys,
  ).toBe(command("insert-before").keys[0]!.join("+").toLowerCase());
  expect(shortcutLabel(command("strikethrough"), true)).toBe("⇧⌘X");
  expect(shortcutLabel(command("save-descendants"), false)).toBe(
    "Ctrl+Shift+S",
  );
  expect(shortcutKeys(command("redo"), false)).toEqual([
    ["Mod", "Y"],
    ["Mod", "Shift", "Z"],
  ]);
});
