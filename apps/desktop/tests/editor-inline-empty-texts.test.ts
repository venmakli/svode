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
function editLast(editor: ReturnType<typeof editorFor>) {
  editor.tf.insertText("!", {
    at: editor.api.end([editor.children.length - 1]),
  });
}

test("a Page link inserted at the end of a paragraph is written without U+200B", () => {
  const editor = editorFor("The plan.\n");
  editor.tf.select(editor.api.end([0]));
  editor.tf.insertText(" ");
  editor.tf.insertNodes({
    type: "a",
    url: "Plan.md",
    children: [{ text: "Plan" }],
  });
  expect(serialize(editor)).toBe("The plan. [Plan](Plan.md)\n");
});

for (const { name, source, at, expected } of [
  {
    name: "links at both edges",
    source: "[docs](docs.md) and [more](more.md)\n",
    at: { path: [0, 1], offset: 4 },
    expected: "[docs](docs.md) and! [more](more.md)\n",
  },
  {
    name: "a link at the end",
    source: "See [docs](docs.md)\n",
    at: { path: [0, 0], offset: 0 },
    expected: "!See [docs](docs.md)\n",
  },
  {
    name: "a link at the end of a quote",
    source: "> See [docs](docs.md)\n",
    at: { path: [0, 0, 0], offset: 0 },
    expected: "> !See [docs](docs.md)\n",
  },
  {
    name: "a mention at the start",
    source: "[@Ann](mention:ann) said\n",
    at: { path: [0, 1], offset: 5 },
    expected: "[@Ann](mention:ann) said!\n",
  },
  {
    name: "a mention at the end",
    source: "Ask [@Ann](mention:ann)\n",
    at: { path: [0, 0], offset: 3 },
    expected: "Ask! [@Ann](mention:ann)\n",
  },
  {
    name: "a date at the end",
    source: 'Due <date value="2026-01-01" />\n',
    at: { path: [0, 0], offset: 3 },
    expected: 'Due! <date value="2026-01-01" />\n',
  },
]) {
  test(`an edit in a paragraph with ${name} adds no U+200B`, () => {
    const editor = editorFor(source);
    editor.tf.insertText("!", { at });
    expect(serialize(editor)).toBe(expected);
  });
}

test("U+200B of the source around a link is kept byte for byte", () => {
  const source = `${ZWSP}[docs](d.md)${ZWSP}\n\nOther\n`;
  const editor = editorFor(source);
  expect(NodeApi.string(editor.children[0])).toBe(`${ZWSP}docs${ZWSP}`);
  editLast(editor);
  expect(serialize(editor)).toBe(`${ZWSP}[docs](d.md)${ZWSP}\n\nOther!\n`);
});

test("U+200B of the source in table cells is kept byte for byte", () => {
  const canonical = serialize(
    editorFor(
      `| A | B |\n| - | - |\n| [One](p.md) | ${ZWSP}[Two](o.md)${ZWSP} |\n\nOther\n`,
    ),
  );
  expect(canonical).toContain(`| [One](p.md) | ${ZWSP}[Two](o.md)${ZWSP} |`);
  const editor = editorFor(canonical);
  editLast(editor);
  expect(serialize(editor)).toBe(canonical.replace("Other", "Other!"));
});

test("an edit in a table cell with a link adds no U+200B", () => {
  const editor = editorFor("| A |\n| - |\n| [One](p.md) |\n");
  editor.tf.insertText("!", { at: editor.api.end([0, 1, 0]) });
  const saved = serialize(editor);
  expect(saved).toContain("[One!](p.md)");
  expect(saved).not.toContain(ZWSP);
});

test("an empty paragraph is still written and read as U+200B", () => {
  const editor = editorFor(`A\n\n${ZWSP}\n\nB\n`);
  const empty = editor.children[1] as TElement;
  expect(empty.children).toEqual([{ text: "" }]);
  editor.tf.select(editor.api.end([0]));
  editor.tf.insertBreak();
  expect(serialize(editor)).toBe(`A\n\n${ZWSP}\n\n${ZWSP}\n\nB\n`);
});
