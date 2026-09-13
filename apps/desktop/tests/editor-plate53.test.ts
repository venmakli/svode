import { expect, test } from "bun:test";
import { BlockquotePlugin } from "@platejs/basic-nodes/react";
import { LinkPlugin } from "@platejs/link/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { KEYS, NodeApi, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { EditorKit } from "../src/features/editor/plate/editor-kit";
import { PageLinkElement } from "../src/features/editor/ui/page-link-element";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { insertBlock, setBlockType } from "../src/components/editor/transforms";

function editorFor(source = "") {
  const editor = createPlateEditor({ plugins: EditorKit });
  loadProgrammaticEditorValue(editor, deserializeWithConflicts(editor, source));
  return editor;
}
function serialize(editor: ReturnType<typeof editorFor>) {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}
function links(editor: ReturnType<typeof editorFor>) {
  return [...NodeApi.descendants(editor)]
    .filter(([node]) => node.type === KEYS.link)
    .map(([node]) => ({ label: NodeApi.string(node), url: node.url }));
}

const cells = [
  "[Alone](page.md)",
  "\u200b[Страница](page.md)\u200b",
  "before [Страница](page.md) after",
  "до [Один](<путь с пробелом.md#раздел>) и [Two](https://example.com/a#b) после",
];
for (const cell of cells) {
  test(`product table preserves inline content: ${cell}`, () => {
    const source = `| ${cell} | Header |\n| --- | --- |\n| ${cell} | tail |\n`;
    const editor = editorFor(source);
    const expectedLinks = links(editor);
    expect(expectedLinks.length).toBe(cell.includes("Two") ? 4 : 2);
    for (let round = 0; round < 3; round += 1) {
      editor.tf.normalize({ force: true });
      const table = editor.children[0] as TElement;
      expect(table.type).toBe("table");
      expect(table.children.length).toBe(2);
      for (const row of table.children as TElement[]) {
        expect(row.type).toBe("tr");
        expect(row.children.length).toBe(2);
        const first = row.children[0] as TElement;
        expect(["td", "th"]).toContain(first.type);
        expect(first.children.length).toBe(1);
        expect((first.children[0] as TElement).type).toBe("p");
      }
      expect(links(editor)).toEqual(expectedLinks);
      const output = serialize(editor);
      if (cell.includes("\u200b"))
        expect(output).toContain("\u200b[Страница](page.md)\u200b");
      if (cell.startsWith("before"))
        expect(output).toContain("before [Страница](page.md) after");
      if (round === 0) {
        editor.tf.insertText(" edited", {
          at: { path: [0, 1, 1, 0, 0], offset: 4 },
        });
      }
      const saved = serialize(editor);
      expect(saved).toContain("tail edited");
      loadProgrammaticEditorValue(
        editor,
        deserializeWithConflicts(editor, saved),
      );
      expect(editor.operations).toEqual([]);
      expect(editor.history.undos).toEqual([]);
    }
  });
}

test("insertion and conflict branch boundary retain table links", () => {
  const editor = editorFor();
  const source = "| H |\n| --- |\n| before [Page](page.md) after |";
  loadProgrammaticEditorValue(
    editor,
    deserializeEditorMarkdownInsertion(editor, source),
  );
  expect(links(editor)).toEqual([{ label: "Page", url: "page.md" }]);
  expect(serialize(editor)).toContain("before [Page](page.md) after");
});

test("quote insertion, turn-into, shortcut transform and Shift+Tab keep nested content", () => {
  const editor = editorFor("text");
  editor.tf.select({ path: [0, 0], offset: 0 });
  setBlockType(editor, KEYS.blockquote);
  expect(serialize(editor).startsWith("> text\n")).toBe(true);
  editor.getTransforms(BlockquotePlugin).blockquote.toggle();
  expect(editor.children[0].type).toBe("p");
  expect(NodeApi.string(editor.children[0])).toBe("text");
  editor.getTransforms(BlockquotePlugin).blockquote.toggle();
  expect(serialize(editor).startsWith("> text\n")).toBe(true);
  editor.tf.tab({ reverse: true });
  expect(editor.children[0].type).toBe("p");
  expect(NodeApi.string(editor.children[0])).toBe("text");
  insertBlock(editor, KEYS.blockquote);
  editor.tf.insertText("new quote");
  expect(serialize(editor)).toContain("> new quote");
  expect(editor.getPlugin(BlockquotePlugin).shortcuts.toggle?.keys).toBe(
    "mod+shift+period",
  );
  const nested = editorFor("> > nested\n> >\n> > - item");
  nested.tf.select({ path: [0, 0, 0, 0], offset: 0 });
  nested.tf.tab({ reverse: true });
  expect(serialize(nested)).toContain("> nested");
  expect(serialize(nested)).toContain("> > - item");
});

test("empty quote insertion places typing inside its paragraph", () => {
  const editor = editorFor();
  editor.tf.select({ path: [0, 0], offset: 0 });
  insertBlock(editor, KEYS.blockquote);
  editor.tf.insertText("inside");
  expect(serialize(editor).startsWith("> inside\n")).toBe(true);
});

test("heading Backspace resets before merging", () => {
  const editor = editorFor("previous\n\n# Heading");
  editor.tf.select({ path: [1, 0], offset: 0 });
  editor.tf.deleteBackward("character");
  expect(editor.children[1].type).toBe("p");
  expect(NodeApi.string(editor.children[1])).toBe("Heading");
  expect(NodeApi.string(editor.children[0])).toBe("previous");
});

for (const [input, expected] of [
  ["> quote", "> quote"],
  ["# Heading", "# Heading"],
  ["- item", "- item"],
  ["3. third", "3. third"],
  ["[] task", "- [ ] task"],
  ["[x] done", "- [x] done"],
  ["**bold**", "**bold**"],
  ["*italic*", "*italic*"],
  ["`code`", "`code`"],
  ["~~strike~~", "~~strike~~"],
  ["```", "```"],
]) {
  test(`product input rule: ${input}`, () => {
    const editor = editorFor();
    editor.tf.select({ path: [0, 0], offset: 0 });
    for (const character of input) editor.tf.insertText(character);
    expect(serialize(editor).trim()).toContain(expected);
  });
}

test("product image caption edits preserve title and portable URL over reopen", () => {
  const editor = editorFor(
    '![Alt текст](./assets/picture.png "Explicit title")',
  );
  const image = editor.children[0];
  expect(image.caption).toEqual([{ text: "Alt текст" }]);
  expect(image.title).toBe("Explicit title");
  editor.tf.setNodes({ caption: [{ text: "Авторская подпись" }] }, { at: [0] });
  const saved = serialize(editor);
  expect(
    saved.startsWith(
      '![Авторская подпись](./assets/picture.png "Explicit title")\n',
    ),
  ).toBe(true);
  loadProgrammaticEditorValue(editor, deserializeWithConflicts(editor, saved));
  expect(editor.children[0].url).toBe("./assets/picture.png");
  expect(editor.children[0].title).toBe("Explicit title");
  expect(editor.children[0].caption).toEqual([{ text: "Авторская подпись" }]);
  const noTitle = editorFor("![Alt](./image.png)");
  expect(serialize(noTitle)).toBe("![Alt](./image.png)\n");
});

test("real product composition retains Page rendering and default-off capabilities", () => {
  const editor = editorFor("foot[^1]\n\n[^1]: Footnote content");
  expect(editor.getPlugin(LinkPlugin).node.component).toBe(PageLinkElement);
  for (const key of [
    "ai",
    "copilot",
    "comment",
    "suggestion",
    "footnote",
    "footnoteReference",
    "footnoteDefinition",
  ]) {
    expect(Object.hasOwn(editor.plugins, key)).toBe(false);
  }
  expect(serialize(editor)).toContain("foot[^1]");
  expect(serialize(editor)).toContain("[^1]: Footnote content");
});

test("nested quotes, tasks, marks, numbered lists and code retain semantic content", () => {
  let source =
    '> quote\n>\n> - [x] done\n> - [ ] pending\n\n3. third\n4. fourth\n\n**bold** *italic* `inline`\n\n```ts\nconst row = "a | b";\n```';
  for (let round = 0; round < 3; round += 1) {
    const editor = editorFor(source);
    source = serialize(editor);
    for (const text of [
      "> quote",
      "> - [x] done",
      "> - [ ] pending",
      "3. third",
      "4. fourth",
      "**bold**",
      "*italic*",
      "`inline`",
      'const row = "a | b";',
    ])
      expect(source).toContain(text);
  }
});

test("eight table links and eight outside links survive the shared acceptance fixture", async () => {
  const source = await Bun.file(
    new URL("./fixtures/plate53-table-links.md", import.meta.url),
  ).text();
  const editor = editorFor(source);
  const expected = links(editor);
  expect(expected.length).toBe(16);
  for (let round = 0; round < 2; round += 1) {
    const saved = serialize(editor);
    loadProgrammaticEditorValue(
      editor,
      deserializeWithConflicts(editor, saved),
    );
    editor.tf.normalize({ force: true });
    expect(links(editor)).toEqual(expected);
  }
});

test("product reload clears previous operations, marks, selection and undo history", () => {
  const editor = editorFor("old document");
  editor.tf.select({ path: [0, 0], offset: 3 });
  editor.tf.insertText(" changed");
  editor.tf.addMark("bold", true);
  expect(editor.history.undos.length).toBeGreaterThan(0);
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, "fresh document"),
  );
  expect(editor.operations).toEqual([]);
  expect(editor.history.undos).toEqual([]);
  expect(editor.history.redos).toEqual([]);
  expect(editor.selection).toBeNull();
  expect(editor.marks).toBeNull();
  expect(NodeApi.string(editor.children[0])).toBe("fresh document");
});
