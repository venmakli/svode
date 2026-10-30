import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { KEYS, NodeApi, type TElement, type TText } from "platejs";
import { createPlateEditor } from "platejs/react";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import {
  type ConflictElement,
  deserializeWithConflicts,
} from "../src/features/editor/conflict/parse-conflicts";
import { INLINE_IMAGE_KEY } from "../src/features/editor/model/markdown-inline-image";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
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

function elementsOf(editor: Editor, type: string): TElement[] {
  return [...NodeApi.elements(editor)]
    .filter(([node]) => node.type === type)
    .map(([node]) => node);
}

function pointAt(editor: Editor, text: string, offset = 0) {
  const entry = [...NodeApi.texts(editor)].find(([node]) =>
    (node as TText).text.includes(text),
  );
  if (!entry) throw new Error(`no text ${text}`);
  const at = (entry[0] as TText).text.indexOf(text) + offset;
  return { path: entry[1], offset: at };
}

function pathOfImage(editor: Editor, index = 0) {
  const entries = [...NodeApi.elements(editor)].filter(
    ([node]) => node.type === INLINE_IMAGE_KEY,
  );
  return entries[index][1];
}

// R1: the line keeps its images where they stand.
for (const [name, source] of [
  ["in the middle", "Before ![logo](./logo.png) after.\n"],
  ["at the start", "![logo](./logo.png) after.\n"],
  ["at the end", "Before ![logo](./logo.png)\n"],
  ["two images with a space", "![a](a.png) ![b](b.png)\n"],
  ["two images with text", "![a](a.png) and ![b](b.png) end\n"],
  ["two adjacent images", "![a](a.png)![b](b.png)\n"],
  ["with a title", 'Pic ![t](t.png "Title") here\n'],
  ["without alt", "Text with ![](noalt.png) image\n"],
  ["next to a link", "![a](a.png) [docs](docs.md)\n"],
  ["next to formatted text", "**bold** ![a](a.png)\n"],
  ["next to an inline comment", "![a](a.png) <!-- note -->\n"],
  ["after a soft line break", "First line\n![a](a.png) second line\n"],
  ["in a bullet list", "- item ![a](a.png) more\n- next\n"],
  [
    "in a nested list",
    "- top\n  - nested ![a](a.png) more\n  - after\n- end\n",
  ],
  ["in an ordered list", "1. one ![a](a.png) two\n2. next\n3. last\n"],
  ["in a quote", "> quote ![a](a.png) more\n"],
  ["among paragraphs", "Intro\n\nBefore ![logo](./logo.png) after.\n\nOutro\n"],
] as const) {
  test(`R1 an image ${name} is written in its line`, () => {
    const editor = editorFor(source);
    const saved = save(editor);
    expect(saved).toBe(source);
    expect(saved).not.toContain("&#x20;");
    expect(elementsOf(editor, KEYS.img)).toEqual([]);
    expect(save(editorFor(saved))).toBe(saved);
  });
}

test("R1 an image in a table cell is written without <br/>", () => {
  const source = "| A | B |\n| - | - |\n| ![a](a.png) text | x |\n";
  const saved = save(editorFor(source));
  expect(saved).toBe(
    "| A                | B |\n| ---------------- | - |\n| ![a](a.png) text | x |\n",
  );
  expect(saved).not.toContain("<br");
  // No space is added on the next round trips.
  expect(save(editorFor(saved))).toBe(saved);
  expect(save(editorFor(save(editorFor(saved))))).toBe(saved);
});

test("R1 the line is one paragraph in the editor", () => {
  const editor = editorFor('Before ![logo](./logo.png "Logo") after.\n');
  expect(editor.children).toHaveLength(1);
  expect(elementsOf(editor, INLINE_IMAGE_KEY)).toEqual([
    {
      type: INLINE_IMAGE_KEY,
      url: "./logo.png",
      alt: "logo",
      title: "Logo",
      children: [{ text: "" }],
    },
  ]);
});

// R3: an image alone in its container stays Plate's block.
for (const [name, source] of [
  ["a paragraph", "![solo](solo.png)\n"],
  ["a paragraph with spaces", "  ![solo](solo.png)  \n"],
  ["a quote", "> ![solo](solo.png)\n"],
] as const) {
  test(`R3 an image alone in ${name} is a block`, () => {
    const editor = editorFor(source);
    expect(elementsOf(editor, KEYS.img)).toHaveLength(1);
    expect(elementsOf(editor, INLINE_IMAGE_KEY)).toEqual([]);
    expect(save(editor)).toBe(
      source.trim().startsWith(">") ? source : "![solo](solo.png)\n",
    );
  });
}

test("R3 an image alone in a table cell is a block", () => {
  const editor = editorFor("| A | B |\n| - | - |\n| ![a](a.png) | x |\n");
  expect(elementsOf(editor, KEYS.img)).toHaveLength(1);
  expect(elementsOf(editor, INLINE_IMAGE_KEY)).toEqual([]);
  expect(save(editor)).toContain("| ![a](a.png) | x |");
});

test("R3 an image next to text, another image or an inline element is inline", () => {
  for (const source of [
    "text ![a](a.png)\n",
    "![a](a.png) ![b](b.png)\n",
    "![a](a.png) [l](l.md)\n",
  ]) {
    const editor = editorFor(source);
    expect(elementsOf(editor, KEYS.img)).toEqual([]);
    expect(elementsOf(editor, INLINE_IMAGE_KEY).length).toBeGreaterThan(0);
  }
});

test("R3 an image left alone after deleting the text around it is written alone and read back as a block", () => {
  const editor = editorFor("Before ![logo](./logo.png) after.\n");
  const imagePath = pathOfImage(editor);
  editor.tf.delete({
    at: {
      anchor: editor.api.start([0])!,
      focus: editor.api.before(imagePath)!,
    },
  });
  editor.tf.delete({
    at: {
      anchor: editor.api.after(pathOfImage(editor))!,
      focus: editor.api.end([0])!,
    },
  });
  const saved = save(editor);
  expect(saved).toBe("![logo](./logo.png)\n");
  const reloaded = editorFor(saved);
  expect(elementsOf(reloaded, KEYS.img)).toHaveLength(1);
  expect(save(reloaded)).toBe(saved);
});

test("R3 an image inserted from the UI is a block", () => {
  const editor = editorFor("Text\n");
  editor.tf.select(editor.api.end([0]));
  editor.tf.insertNodes({
    type: KEYS.img,
    url: "new.png",
    children: [{ text: "" }],
  });
  expect(elementsOf(editor, KEYS.img)).toHaveLength(1);
  expect(elementsOf(editor, INLINE_IMAGE_KEY)).toEqual([]);
});

// R4: the image is part of the line.
test("R4 typing and formatting around the image keep it in the line", () => {
  const editor = editorFor("Before ![logo](./logo.png) after.\n");
  editor.tf.insertText("Just ", { at: editor.api.start([0]) });
  editor.tf.insertText("!", { at: editor.api.end([0]) });
  editor.tf.insertText("X", { at: editor.api.before(pathOfImage(editor))! });
  editor.tf.insertText("Y", { at: editor.api.after(pathOfImage(editor))! });
  editor.tf.select({
    anchor: pointAt(editor, "after"),
    focus: pointAt(editor, "after", 5),
  });
  editor.tf.toggleMark(KEYS.bold);
  expect(save(editor)).toBe("Just Before X![logo](./logo.png)Y **after**.!\n");
});

test("R4 Enter before and after the image keeps it in its part of the line", () => {
  const before = editorFor("Before ![logo](./logo.png) after.\n");
  before.tf.select(before.api.before(pathOfImage(before))!);
  before.tf.insertBreak();
  // The space the user left at the end of the first line is escaped as for
  // any paragraph.
  expect(save(before)).toBe("Before&#x20;\n\n![logo](./logo.png) after.\n");

  const after = editorFor("Before ![logo](./logo.png) after.\n");
  after.tf.select(after.api.after(pathOfImage(after))!);
  after.tf.insertBreak();
  expect(save(after)).toBe("Before ![logo](./logo.png)\n\n&#x20;after.\n");
});

test("R4 Backspace and Delete remove the image and Undo restores it", () => {
  const source = "Before ![logo](./logo.png) after.\n";
  const backspace = editorFor(source);
  backspace.tf.select(backspace.api.after(pathOfImage(backspace))!);
  backspace.tf.deleteBackward("character");
  expect(save(backspace)).toBe("Before  after.\n");
  backspace.undo();
  expect(save(backspace)).toBe(source);

  const del = editorFor(source);
  del.tf.select(del.api.before(pathOfImage(del))!);
  del.tf.deleteForward("character");
  expect(save(del)).toBe("Before  after.\n");
  del.undo();
  expect(save(del)).toBe(source);
});

test("R4 cut and paste move the image with the text", () => {
  const source = "Intro\n\nBefore ![logo](./logo.png) after.\n";
  const editor = editorFor(source);
  editor.tf.select({
    anchor: pointAt(editor, "Before"),
    focus: editor.api.end([1])!,
  });
  const fragment = editor.api.fragment();
  editor.tf.deleteFragment();
  editor.tf.removeNodes({ at: [1] });
  editor.tf.select(editor.api.end([0]));
  editor.tf.insertText(" ");
  editor.tf.insertFragment(fragment);
  expect(save(editor)).toBe("Intro Before ![logo](./logo.png) after.\n");
  expect(elementsOf(editor, INLINE_IMAGE_KEY)).toHaveLength(1);
  while (editor.history.undos.length > 0) editor.undo();
  expect(save(editor)).toBe(source);
});

// R5: every Markdown path reads the image the same way.
test("R5 pasted Markdown and a conflict side read the image inline", () => {
  const editor = editorFor("Text\n");
  const pasted = deserializeEditorMarkdownInsertion(
    editor,
    "Before ![logo](./logo.png) after.",
  );
  expect(pasted).toHaveLength(1);
  expect(
    (pasted[0] as TElement).children.some(
      (child) => (child as TElement).type === INLINE_IMAGE_KEY,
    ),
  ).toBe(true);

  const conflicted = editorFor(
    "Intro\n\n<<<<<<< ours\nOurs ![a](a.png) line\n=======\nTheirs ![b](b.png) line\n>>>>>>> theirs\n",
  );
  const index = conflicted.children.findIndex(
    (node) => (node as TElement).type === "conflict",
  );
  const conflict = conflicted.children[index] as unknown as ConflictElement;
  // Same insertion as `ConflictElementComponent.replaceWithMarkdown` (Edit).
  const fragment = deserializeEditorMarkdownInsertion(
    conflicted,
    `${conflict.ours}\n\n---\n\n${conflict.theirs}`.trim() + "\n",
  );
  conflicted.tf.removeNodes({ at: [index] });
  conflicted.tf.insertNodes(fragment as never, { at: [index] });
  expect(elementsOf(conflicted, KEYS.img)).toEqual([]);
  expect(save(conflicted)).toBe(
    "Intro\n\nOurs ![a](a.png) line\n\n---\n\nTheirs ![b](b.png) line\n",
  );
});

// R6: everything around inline images is unchanged.
for (const [name, source] of [
  ["a block image", "Intro\n\n![solo](solo.png)\n\nOutro\n"],
  ["a block image with a title", '![solo](solo.png "Title")\n'],
  ["a link to an image file", "See [logo](./logo.png) here.\n"],
  ["a paragraph of the user with an edge space", "&#x20;lead and tail&#x20;\n"],
  ["a block comment", "Text\n\n<!-- block -->\n"],
  ["an image inside a link", "[![logo](logo.png)](./plan.md)\n"],
] as const) {
  test(`R6 ${name} is unchanged`, () => {
    expect(save(editorFor(source))).toBe(source);
  });
}

test("R6 no U+200B is written around an inline image at the edges", () => {
  const editor = editorFor("![a](a.png) middle ![b](b.png)\n");
  editor.tf.insertText("!", { at: pointAt(editor, "middle", 6) });
  const saved = save(editor);
  expect(saved).toBe("![a](a.png) middle! ![b](b.png)\n");
  expect(saved).not.toContain("​");
});
