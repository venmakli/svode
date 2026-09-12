import type { ShortcutDescription } from "@/shared/lib/shortcut-description";
import * as m from "@/paraglide/messages.js";

export const editorFormattingShortcuts = {
  bold: { id: "bold", label: m.editor_format_bold, keys: [["Mod", "B"]] },
  italic: { id: "italic", label: m.editor_format_italic, keys: [["Mod", "I"]] },
  underline: {
    id: "underline",
    label: m.editor_format_underline,
    keys: [["Mod", "U"]],
  },
  strikethrough: {
    id: "strikethrough",
    label: m.editor_format_strikethrough,
    keys: [["Mod", "Shift", "X"]],
  },
  code: { id: "code", label: m.editor_format_code, keys: [["Mod", "E"]] },
  link: { id: "link", label: m.editor_format_link, keys: [["Mod", "K"]] },
} satisfies Record<string, ShortcutDescription>;

export const editorShortcuts = [
  ...Object.values(editorFormattingShortcuts),
  {
    id: "highlight",
    label: m.shortcuts_highlight,
    keys: [["Mod", "Shift", "H"]],
  },
  { id: "subscript", label: m.shortcuts_subscript, keys: [["Mod", ","]] },
  { id: "superscript", label: m.shortcuts_superscript, keys: [["Mod", "."]] },
  { id: "undo", label: m.shortcuts_undo, keys: [["Mod", "Z"]] },
  {
    id: "redo",
    label: m.shortcuts_redo,
    keys: [["Mod", "Shift", "Z"]],
    windowsKeys: [
      ["Mod", "Y"],
      ["Mod", "Shift", "Z"],
    ],
  },
  {
    id: "heading-1",
    label: m.shortcuts_heading_1,
    keys: [["Mod", "Alt", "1"]],
  },
  {
    id: "heading-2",
    label: m.shortcuts_heading_2,
    keys: [["Mod", "Alt", "2"]],
  },
  {
    id: "heading-3",
    label: m.shortcuts_heading_3,
    keys: [["Mod", "Alt", "3"]],
  },
  {
    id: "heading-4",
    label: m.shortcuts_heading_4,
    keys: [["Mod", "Alt", "4"]],
  },
  {
    id: "heading-5",
    label: m.shortcuts_heading_5,
    keys: [["Mod", "Alt", "5"]],
  },
  {
    id: "heading-6",
    label: m.shortcuts_heading_6,
    keys: [["Mod", "Alt", "6"]],
  },
  {
    id: "code-block",
    label: m.shortcuts_code_block,
    keys: [["Mod", "Alt", "8"]],
  },
  { id: "quote", label: m.shortcuts_quote, keys: [["Mod", "Shift", "."]] },
  {
    id: "insert-after",
    label: m.shortcuts_insert_after,
    keys: [["Mod", "Enter"]],
  },
  {
    id: "insert-before",
    label: m.shortcuts_insert_before,
    keys: [["Mod", "Shift", "Enter"]],
  },
] satisfies readonly ShortcutDescription[];
