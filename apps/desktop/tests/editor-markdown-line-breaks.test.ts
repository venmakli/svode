import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement, type TText } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import type { ConflictElement } from "../src/features/editor/conflict/parse-conflicts";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { SOFT_LINE_BREAK } from "../src/features/editor/model/markdown-line-breaks";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

function editorFor(source: string): Editor {
  const editor = createPlateEditor({ plugins: EditorKit });
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, source, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  return editor;
}

function save(editor: Editor): string {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}

function texts(editor: Editor): TText[] {
  return [...NodeApi.texts(editor)].map(([node]) => node);
}

function textEntry(editor: Editor, text: string) {
  const entry = [...NodeApi.texts(editor)].find(([node]) =>
    node.text.includes(text),
  );
  if (!entry) throw new Error(`no text ${text}`);
  return entry;
}

function softBreakEntries(editor: Editor) {
  return [...NodeApi.texts(editor)].filter(
    ([node]) => (node as Record<string, unknown>)[SOFT_LINE_BREAK] === true,
  );
}

// Sources a load → save keeps byte for byte.
const kept: Record<string, string> = {
  paragraph: "line one\nline two\n",
  threeLines: "one\ntwo\nthree\n",
  blockquote: "> quote one\n> quote two\n",
  bulletItem: "- item one\n  continued\n- next\n",
  nestedItem: "- a\n  - nested\n    more\n",
  orderedItem: "1. first\n   still first\n2. second\n",
  emphasisAcross: "**bold\nmore** tail\n",
  italicAcross: "*one\ntwo* end\n",
  inlineCodeAcross: "Intro `code\nmore` end\n",
  afterLink: "a [link](x.md)\nb\n",
  afterPageLink: "See [Plan](./plan.md)\nnext line\n",
  afterBareUrl: "a https://example.com/a\nb\n",
  afterEmphasis: "a *em*\nb\n",
  afterStrong: "a **strong**\nb\n",
  afterInlineCode: "a `code`\nb\n",
  afterInlineComment: "text <!-- c -->\nnext\n",
  beforeLink: "a\n[link](x.md) b\n",
  hardBackslash: "hard\\\nbreak\n",
  hardInBlockquote: "> hard\\\n> break\n",
  hardInListItem: "- x\\\n  y\n- z\n",
  softAndHard: "one\ntwo\\\nthree\nfour\n",
  softThenHard: "one\n\\\ntwo\n",
  heading: "# Title\n\nline one\nline two\n",
  table: "| A | B |\n| - | - |\n| 1 | 2 |\n",
};

for (const [name, source] of Object.entries(kept)) {
  test(`${name}: load → save keeps the line breaks`, () => {
    const saved = save(editorFor(source));
    expect(saved).toBe(source);
    expect(save(editorFor(saved))).toBe(saved);
  });
}

// Hard breaks in other forms are written as `\` + LF.
const hard: Record<string, [string, string]> = {
  twoSpaces: ["two  \nspaces\n", "two\\\nspaces\n"],
  bareBr: ["text<br>\nnext\n", "text\\\nnext\n"],
  selfClosingBr: ["text<br />\nnext\n", "text\\\nnext\n"],
  brInEmphasis: ["a **b<br />\nc**\n", "a **b**\\\n**c**\n"],
  brWithoutLineEnding: ["a<br />b\n", "a\\\nb\n"],
};

for (const [name, [source, expected]] of Object.entries(hard)) {
  test(`${name}: a hard line break stays one hard line break`, () => {
    const saved = save(editorFor(source));
    expect(saved).toBe(expected);
    expect(save(editorFor(saved))).toBe(saved);
  });
}

test("a soft line break is a marked text of its own, a hard one is not", () => {
  const soft = editorFor("line one\nline two\n");
  expect(texts(soft)).toEqual([
    { text: "line one" },
    { text: "\n", [SOFT_LINE_BREAK]: true },
    { text: "line two" },
  ]);
  const afterLink = editorFor("a [link](x.md)\nb\n");
  expect(softBreakEntries(afterLink)).toHaveLength(1);
  const hardBreak = editorFor("hard\\\nbreak\n");
  expect(softBreakEntries(hardBreak)).toHaveLength(0);
  expect(texts(hardBreak).map((node) => node.text)).toEqual([
    "hard",
    "\n",
    "break",
  ]);
});

test("edits elsewhere in the paragraph and document keep soft line breaks", () => {
  const source =
    "Intro\n\nline one [link](x.md)\nline two **bold\nmore**\n\n> quote one\n> quote two\n\n- item\n  continued\n";
  const editor = editorFor(source);
  const [, introPath] = textEntry(editor, "Intro");
  editor.tf.insertText(" edited", { at: { path: introPath, offset: 5 } });
  const [, linePath] = textEntry(editor, "line two");
  editor.tf.select({ path: linePath, offset: 8 });
  editor.tf.insertText(" typed");
  const [, quotePath] = textEntry(editor, "quote two");
  editor.tf.insertText("!", { at: { path: quotePath, offset: 9 } });
  const expected = source
    .replace("Intro", "Intro edited")
    .replace("line two", "line two typed")
    .replace("quote two", "quote two!");
  expect(save(editor)).toBe(expected);
  expect(save(editorFor(expected))).toBe(expected);
});

test("text typed on either side of a soft line break does not take its mark", () => {
  for (const [path, offset] of [
    [[0, 1], 0],
    [[0, 1], 1],
  ] as const) {
    const editor = editorFor("line one\nline two\n");
    editor.tf.select({ path: [...path], offset });
    editor.tf.insertText("x");
    expect(softBreakEntries(editor).map(([node]) => node.text)).toEqual(["\n"]);
    expect(save(editor)).toBe(
      offset === 0 ? "line onex\nline two\n" : "line one\nxline two\n",
    );
  }
});

test("a mark toggled at a soft line break does not carry it to typed text", () => {
  const editor = editorFor("line one\nline two\n");
  editor.tf.select({ path: [0, 1], offset: 1 });
  editor.tf.toggleMark("bold");
  editor.tf.insertText("x");
  expect(save(editor)).toBe("line one\n**x**line two\n");
  expect(softBreakEntries(editor)).toHaveLength(1);
});

test("Shift+Enter inserts a hard line break, next to a soft one too", () => {
  const plain = editorFor("lineone\n");
  plain.tf.select({ path: [0, 0], offset: 4 });
  plain.tf.insertSoftBreak();
  expect(save(plain)).toBe("line\\\none\n");

  for (const [path, offset, expected] of [
    [[0, 1], 0, "line one\\\n\\\nline two\n"],
    [[0, 1], 1, "line one\n\\\nline two\n"],
    [[0, 0], 8, "line one\\\n\\\nline two\n"],
    [[0, 2], 0, "line one\n\\\nline two\n"],
  ] as const) {
    const editor = editorFor("line one\nline two\n");
    editor.tf.select({ path: [...path], offset });
    editor.tf.insertSoftBreak();
    expect(softBreakEntries(editor)).toHaveLength(1);
    expect(save(editor)).toBe(expected);
    expect(save(editorFor(expected))).toBe(expected);
  }

  const item = editorFor("- itemone\n- next\n");
  item.tf.select({ path: [0, 0], offset: 4 });
  item.tf.insertSoftBreak();
  expect(save(item)).toBe("- item\\\n  one\n- next\n");
});

test("a deleted soft line break does not come back", () => {
  const backward = editorFor("line one\nline two\n");
  backward.tf.select({ path: [0, 2], offset: 0 });
  backward.tf.deleteBackward("character");
  expect(save(backward)).toBe("line oneline two\n");

  const forward = editorFor("a [link](x.md)\nb\n");
  const [, linkTextPath] = textEntry(forward, "link");
  forward.tf.select({ path: linkTextPath, offset: 4 });
  forward.tf.deleteForward("character");
  expect(softBreakEntries(forward)).toHaveLength(0);
  expect(save(forward)).toBe("a [link](x.md)b\n");
});

test("soft line breaks that meet are written as hard ones", () => {
  const editor = editorFor("one\ntwo\nthree\n");
  editor.tf.delete({
    at: {
      anchor: { path: [0, 2], offset: 0 },
      focus: { path: [0, 2], offset: 3 },
    },
  });
  expect(save(editor)).toBe("one\\\n\\\nthree\n");
  expect(save(editorFor("one\\\n\\\nthree\n"))).toBe("one\\\n\\\nthree\n");
});

test("Enter at a soft line break leaves no line break at a paragraph edge", () => {
  const editor = editorFor("line one\nline two\n");
  editor.tf.select({ path: [0, 0], offset: 8 });
  editor.tf.insertBreak();
  const saved = save(editor);
  expect(saved).toBe("line one\n\n\\\nline two\n");
  expect(save(editorFor(saved))).toBe(saved);
});

test("text that reaches a soft line break another way is split off", () => {
  const editor = editorFor("line one\nline two\n");
  editor.tf.insertText("x", { at: { path: [0, 1], offset: 1 } });
  expect(softBreakEntries(editor).map(([node]) => node.text)).toEqual(["\n"]);
  expect(save(editor)).toBe("line one\nxline two\n");
});

test("Markdown pasted as plain text keeps soft line breaks soft", () => {
  const editor = editorFor("Existing\n\nTarget\n");
  editor.tf.select({ path: [1, 0], offset: 6 });
  const data: Record<string, string> = {
    "text/plain":
      "Pasted line\nsoft break after [link](x.md)\nend\n\n- item\n  more\n",
  };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    getData: (type: string) => data[type] ?? "",
    types: Object.keys(data),
  } as unknown as DataTransfer);
  const saved = save(editor);
  expect(saved).toContain("Pasted line\nsoft break after [link](x.md)\nend\n");
  expect(saved).toContain("- item\n  more\n");
  expect(saved).not.toContain("\\\n");
});

test("toolbar Markdown import keeps soft line breaks soft", () => {
  const editor = editorFor("Existing\n");
  const markdown = "Imported line\nnext after [link](x.md)\nend\n";
  const fragment = deserializeImportedMarkdown(markdown, (text) =>
    deserializeEditorMarkdownInsertion(editor, text),
  );
  editor.tf.insertNodes(fragment as never, { at: [1] });
  expect(save(editor)).toBe(`Existing\n\n${markdown}`);
});

test("conflict branches keep soft line breaks soft", () => {
  const source =
    "<<<<<<< HEAD\nOurs line\nsoft [link](x.md)\nend\n=======\n> Theirs\n> quote\n>>>>>>> branch\n";
  for (const choice of ["ours", "theirs"] as const) {
    const editor = editorFor(source);
    const index = editor.children.findIndex(
      (node) => (node as TElement).type === "conflict",
    );
    const conflict = editor.children[index] as unknown as ConflictElement;
    // Same insertion as `ConflictElementComponent.replaceWithMarkdown`.
    const fragment = deserializeEditorMarkdownInsertion(
      editor,
      conflict[choice].trim() + "\n",
    );
    editor.tf.removeNodes({ at: [index] });
    editor.tf.insertNodes(fragment as never, { at: [index] });
    expect(save(editor)).toBe(
      choice === "ours"
        ? "Ours line\nsoft [link](x.md)\nend\n"
        : "> Theirs\n> quote\n",
    );
  }
});

test("Routine field change keeps soft line breaks of untouched text", () => {
  const value = "Step one\nstill one [link](x.md)\nafter\n\n- item\n  more\n";
  // Same calls as `ControlledMarkdownEditor`: value init and onChange.
  const editor = createPlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, value) as never,
  });
  const [, path] = textEntry(editor, "Step");
  editor.tf.insertText("First ", { at: { path, offset: 0 } });
  expect(
    editor
      .getApi(MarkdownPlugin)
      .markdown.serialize({ value: editor.children }),
  ).toBe(value.replace("Step", "First Step"));
});
