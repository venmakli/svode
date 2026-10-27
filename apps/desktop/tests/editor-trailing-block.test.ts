import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { EditorKit } from "../src/features/editor/plate/editor-kit";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";

const ZWSP = "\u200b";

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
function editIntro(editor: ReturnType<typeof editorFor>) {
  editor.tf.insertText("!", { at: editor.api.end([0]) });
}
function lastBlock(editor: ReturnType<typeof editorFor>) {
  return editor.children.at(-1) as TElement;
}
function selectEnd(editor: ReturnType<typeof editorFor>, index: number) {
  editor.tf.select(editor.api.end([index]));
}

const TABLE = "| A | B |\n| - | - |\n| 1 | 2 |";
const endings = [
  { name: "table", block: TABLE },
  { name: "quote", block: "> q" },
  { name: "line", block: "---" },
  { name: "code block", block: "```js\nconst a = 1;\n```" },
  { name: "heading", block: "## Head" },
  { name: "image", block: "![alt](a.png)" },
];

for (const { name, block } of endings) {
  test(`a Page ending with a ${name} saves an edit elsewhere without the trailing paragraph`, () => {
    const editor = editorFor(`Intro\n\n${block}\n`);
    editIntro(editor);
    expect(serialize(editor)).toBe(`Intro!\n\n${block}\n`);
    const trailing = lastBlock(editor);
    expect(trailing.type).toBe("p");
    expect(NodeApi.string(trailing)).toBe("");
    expect(editor.children.length).toBe(3);
  });
}

test("text typed in the trailing paragraph is written, and not once erased", () => {
  const editor = editorFor(`Intro\n\n${TABLE}\n`);
  editIntro(editor);
  const index = editor.children.length - 1;
  editor.tf.insertText("Tail", { at: editor.api.end([index]) });
  expect(serialize(editor)).toBe(`Intro!\n\n${TABLE}\n\nTail\n`);
  editor.tf.delete({
    at: { anchor: editor.api.start([index])!, focus: editor.api.end([index])! },
  });
  expect(NodeApi.string(lastBlock(editor))).toBe("");
  expect(serialize(editor)).toBe(`Intro!\n\n${TABLE}\n`);
});

test("a paragraph split off the trailing paragraph by Enter is the user's", () => {
  const editor = editorFor(`Intro\n\n> q\n`);
  editIntro(editor);
  const index = editor.children.length - 1;
  editor.tf.insertText("Tail", { at: editor.api.end([index]) });
  selectEnd(editor, index);
  editor.tf.insertBreak();
  expect(editor.children.length).toBe(4);
  expect(serialize(editor)).toBe(`Intro!\n\n> q\n\nTail\n\n${ZWSP}\n`);
});

test("Enter in the empty trailing paragraph writes the paragraph it adds", () => {
  const editor = editorFor(`Intro\n\n> q\n`);
  editIntro(editor);
  selectEnd(editor, editor.children.length - 1);
  editor.tf.insertBreak();
  expect(editor.children.length).toBe(4);
  expect(serialize(editor)).toBe(`Intro!\n\n> q\n\n${ZWSP}\n\n${ZWSP}\n`);
});

test("an empty last paragraph of the source is kept, and not restored once deleted", () => {
  const source = `Intro\n\n${TABLE}\n\n${ZWSP}\n`;
  const editor = editorFor(source);
  editIntro(editor);
  expect(serialize(editor)).toBe(`Intro!\n\n${TABLE}\n\n${ZWSP}\n`);
  editor.tf.removeNodes({ at: [editor.children.length - 1] });
  expect(NodeApi.string(lastBlock(editor))).toBe("");
  expect(serialize(editor)).toBe(`Intro!\n\n${TABLE}\n`);
});

test("empty paragraphs in the middle and from Enter are written as before", () => {
  const editor = editorFor(`Intro\n\n${ZWSP}\n\nMiddle\n\n${TABLE}\n`);
  selectEnd(editor, 2);
  editor.tf.insertBreak();
  expect(serialize(editor)).toBe(
    `Intro\n\n${ZWSP}\n\nMiddle\n\n${ZWSP}\n\n${TABLE}\n`,
  );
});

test("a Page ending with a list is unchanged", () => {
  const editor = editorFor("Intro\n\n- a\n- b\n");
  editIntro(editor);
  expect(serialize(editor)).toBe("Intro!\n\n- a\n- b\n");
  expect(NodeApi.string(lastBlock(editor))).toBe("b");
});
