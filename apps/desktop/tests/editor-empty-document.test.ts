import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { EditorKit } from "../src/features/editor/plate/editor-kit";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";

const ZWSP = "​";
const TABLE = "| A | B |\n| - | - |\n| 1 | 2 |";

function editorFor(source: string) {
  const editor = createPlateEditor({ plugins: EditorKit });
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, source, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  return editor;
}
function serialize(editor: ReturnType<typeof editorFor>) {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}
function deleteAll(editor: ReturnType<typeof editorFor>) {
  editor.tf.select([]);
  editor.tf.deleteFragment();
}
function expectOneEmptyParagraph(editor: ReturnType<typeof editorFor>) {
  expect(editor.children.length).toBe(1);
  const block = editor.children[0] as TElement;
  expect(block.type).toBe("p");
  expect(NodeApi.string(block)).toBe("");
}

const documents = [
  { name: "a paragraph", source: "Text\n" },
  { name: "several paragraphs", source: "One\n\nTwo\n\nThree\n" },
  { name: "a heading with text", source: "# Head\n\nText\n" },
  { name: "a list", source: "- a\n- b\n" },
  { name: "a paragraph ending with a table", source: `Intro\n\n${TABLE}\n` },
  { name: "a single table", source: `${TABLE}\n` },
];

for (const { name, source } of documents) {
  test(`deleting all of ${name} writes an empty document, and typing after it writes the text`, () => {
    const editor = editorFor(source);
    editor.tf.insertText("!", { at: editor.api.end([0]) });
    deleteAll(editor);
    expectOneEmptyParagraph(editor);
    expect(serialize(editor)).toBe("");

    editor.tf.insertText("Typed", { at: editor.api.start([0]) });
    expect(serialize(editor)).toBe("Typed\n");
    deleteAll(editor);
    expect(serialize(editor)).toBe("");
  });
}

test("a source of one U+200B paragraph opens as an empty document", () => {
  const editor = editorFor(`${ZWSP}\n`);
  expectOneEmptyParagraph(editor);
  expect(serialize(editor)).toBe("");
  editor.tf.insertText("Typed", { at: editor.api.start([0]) });
  expect(serialize(editor)).toBe("Typed\n");
});

test("empty paragraphs between other blocks are written as before", () => {
  const editor = editorFor(`A\n\n${ZWSP}\n\nB\n`);
  editor.tf.insertText("!", { at: editor.api.end([0]) });
  expect(serialize(editor)).toBe(`A!\n\n${ZWSP}\n\nB\n`);
});

test("a document of two empty paragraphs is written as before", () => {
  const editor = editorFor(`${ZWSP}\n\n${ZWSP}\n`);
  expect(editor.children.length).toBe(2);
  expect(serialize(editor)).toBe(`${ZWSP}\n\n${ZWSP}\n`);
});

test("a document of an empty list item or an empty heading is not empty", () => {
  for (const [source, written] of [
    ["- a\n", "-\n"],
    ["# H\n", "#\n"],
  ]) {
    const editor = editorFor(source);
    editor.tf.delete({
      at: { anchor: editor.api.start([0])!, focus: editor.api.end([0])! },
    });
    expect(NodeApi.string(editor.children[0])).toBe("");
    expect(serialize(editor)).toBe(written);
  }
});
