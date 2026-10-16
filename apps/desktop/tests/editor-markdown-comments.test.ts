import { expect, test } from "bun:test";
import { BoldPlugin } from "@platejs/basic-nodes/react";
import { htmlToJsx, MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type Descendant, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import type { ConflictElement } from "../src/features/editor/conflict/parse-conflicts";
import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
} from "../src/features/editor/model/markdown-comments";
import {
  deserializeEditorMarkdownInsertion,
  deserializeEditorMarkdownSegment,
} from "../src/features/editor/model/markdown-io";
import { mapHtmlToJsx } from "../src/features/editor/model/markdown-source";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

function editorFor(source = ""): Editor {
  const editor = createPlateEditor({ plugins: EditorKit });
  loadProgrammaticEditorValue(editor, deserializeWithConflicts(editor, source));
  return editor;
}

function save(editor: Editor): string {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}

function comments(nodes: Descendant[]): string[] {
  const found: string[] = [];
  const visit = (node: Descendant) => {
    const element = node as TElement & { raw?: string };
    if (
      element.type === MARKDOWN_COMMENT_KEY ||
      element.type === MARKDOWN_INLINE_COMMENT_KEY
    ) {
      found.push(element.raw ?? "");
    }
    for (const child of (element.children ?? []) as Descendant[]) visit(child);
  };
  nodes.forEach(visit);
  return found;
}

function pathOfText(editor: Editor, text: string) {
  for (const [node, path] of NodeApi.texts(editor)) {
    const offset = node.text.indexOf(text);
    if (offset !== -1) return { path, offset };
  }
  throw new Error(`text not found: ${text}`);
}

// Regression corpus of the 2026-10-04 and 2026-10-16 probes. Each source is
// already in house style, so load → save must give it back byte for byte.
const corpus: Record<string, { source: string; comments: string[] }> = {
  block: {
    source: "Text before\n\n<!-- html comment -->\n\nAfter\n",
    comments: ["<!-- html comment -->"],
  },
  inline: {
    source: "After <!-- inline --> text\n",
    comments: ["<!-- inline -->"],
  },
  multilineIndented: {
    source: "start\n\n<!--\n  multi\n    indented\n-->\n\nend\n",
    comments: ["<!--\n  multi\n    indented\n-->"],
  },
  multilineInline: {
    source: "Text <!-- a\n   b\n --> after\n",
    comments: ["<!-- a\n   b\n -->"],
  },
  fileStart: {
    source: "<!-- top -->\n\n# Title\n",
    comments: ["<!-- top -->"],
  },
  mdxForms: {
    source: "{/* mdx comment */}\n\nx {/* inline\n  mdx */} y\n",
    comments: ["{/* mdx comment */}", "{/* inline\n  mdx */}"],
  },
  definitionForms: {
    source:
      '[//]: # (link comment)\n\n[//]: # "quoted"\n\n[//]: <> (empty url)\n\npara\n',
    comments: [
      "[//]: # (link comment)",
      '[//]: # "quoted"',
      "[//]: <> (empty url)",
    ],
  },
  heading: {
    source: "# Head <!-- h -->\n",
    comments: ["<!-- h -->"],
  },
  bulletList: {
    source:
      "- one <!-- inline -->\n- two\n  <!-- block -->\n- <!-- lead -->\n- three\n",
    comments: ["<!-- inline -->", "<!-- block -->", "<!-- lead -->"],
  },
  nestedBulletList: {
    source: "- a\n  - b\n    <!-- in b -->\n  <!-- after b -->\n  - e\n- f\n",
    comments: ["<!-- in b -->", "<!-- after b -->"],
  },
  orderedList: {
    source: "1. a\n   <!-- c -->\n2. b\n3. c\n",
    comments: ["<!-- c -->"],
  },
  nestedOrderedList: {
    source:
      "1. a\n   1. b\n      <!-- deep -->\n   2. c\n   <!-- mid -->\n   3. e\n2. d\n",
    comments: ["<!-- deep -->", "<!-- mid -->"],
  },
  taskList: {
    source: "- [ ] task <!-- t -->\n- [x] done\n",
    comments: ["<!-- t -->"],
  },
  multilineInList: {
    source:
      "- a\n  {/*\n    keep\n      indent\n  */}\n- b <!-- x\n  y --> z\n",
    comments: ["{/*\n  keep\n    indent\n*/}", "<!-- x\ny -->"],
  },
  definitionInList: {
    source: "- one\n\n  [//]: # (c)\n- two\n",
    comments: ["[//]: # (c)"],
  },
  blockquote: {
    source: "> quote <!-- inline -->\n>\n> <!-- a\n>   b -->\n",
    comments: ["<!-- inline -->", "<!-- a\n  b -->"],
  },
  listInBlockquote: {
    source: "> - item\n>   <!-- in quote list -->\n> - next\n",
    comments: ["<!-- in quote list -->"],
  },
  tableCell: {
    source:
      "| A            | B |\n| ------------ | - |\n| x <!-- c --> | y |\n",
    comments: ["<!-- c -->"],
  },
  twoInARow: {
    source: "<!-- first -->\n\n<!-- second -->\n\nx <!-- a --><!-- b --> y\n",
    comments: ["<!-- first -->", "<!-- second -->", "<!-- a -->", "<!-- b -->"],
  },
};

for (const [name, { source, comments: expected }] of Object.entries(corpus)) {
  test(`comment corpus round trip: ${name}`, () => {
    const editor = editorFor(source);
    expect(comments(editor.children)).toEqual(expected);
    const saved = save(editor);
    expect(saved).toBe(source);
    expect(save(editorFor(saved))).toBe(source);
  });
}

test("blank lines around tight comments follow house style and then stay stable", () => {
  const editor = editorFor(
    "Text\n<!-- tight -->\nmore\n<!-- one -->\n<!-- two -->\n",
  );
  const saved = save(editor);
  expect(saved).toBe(
    "Text\n\n<!-- tight -->\n\nmore\n\n<!-- one -->\n\n<!-- two -->\n",
  );
  expect(save(editorFor(saved))).toBe(saved);
});

test("a block comment in a list item keeps the list, its nesting and numbering", () => {
  const editor = editorFor("1. a\n   <!-- c -->\n2. b\n   - nested\n3. c\n");
  const items = editor.children.filter(
    (node) => (node as TElement).listStyleType === "decimal",
  ) as TElement[];
  expect(items.map((item) => item.listStart)).toEqual([1, 2, 3]);
  expect(editor.children[1]).toMatchObject({
    type: MARKDOWN_COMMENT_KEY,
    indent: 2,
  });
  editor.tf.normalize({ force: true });
  expect(editor.children[1]).toMatchObject({ indent: 2 });
  expect(save(editor)).toBe("1. a\n   <!-- c -->\n2. b\n   - nested\n3. c\n");
});

test("comment text comes from the source, not from the rewritten MDX expression", () => {
  const source = "<!-- keep <br> class=x for=y disabled -->\n";
  const editor = editorFor(source);
  expect(comments(editor.children)).toEqual([source.trimEnd()]);
  expect(save(editor)).toBe(source);
});

test("comments inside code are not comments", () => {
  const editor = editorFor(
    "```html\n<!-- in code -->\n```\n\n`<!-- inline code -->` and <!-- real -->\n",
  );
  expect(comments(editor.children)).toEqual(["<!-- real -->"]);
});

test("an expression that is not only a comment stays outside the comment model", () => {
  const editor = editorFor("x {a /* note */} y\n");
  expect(comments(editor.children)).toEqual([]);
});

// R4: every Markdown → editor value path gives the same comment elements.
const pathSource =
  "Intro <!-- inline -->\n\n<!-- block -->\n\n- item\n  <!-- in list -->\n\nEnd\n";
const pathComments = ["<!-- inline -->", "<!-- block -->", "<!-- in list -->"];

test("R4 Page load and watcher reload keep comments", () => {
  const editor = editorFor("Old text\n");
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, pathSource),
  );
  expect(comments(editor.children)).toEqual(pathComments);
  expect(save(editor)).toBe(pathSource);
});

test("R4 Accept and Edit of a conflict branch keep the branch comments", () => {
  const conflicted =
    "# Title\n\n<<<<<<< HEAD\nOurs <!-- ours note -->\n=======\nTheirs\n\n<!-- theirs note -->\n>>>>>>> branch\n";
  for (const choice of ["ours", "theirs", "edit"] as const) {
    const editor = editorFor(conflicted);
    const index = editor.children.findIndex(
      (node) => (node as TElement).type === "conflict",
    );
    const conflict = editor.children[index] as unknown as ConflictElement;
    const markdown =
      choice === "ours"
        ? conflict.ours
        : choice === "theirs"
          ? conflict.theirs
          : `${conflict.ours}\n\n---\n\n${conflict.theirs}`;
    // Same insertion as `ConflictElementComponent.replaceWithMarkdown`.
    const fragment = deserializeEditorMarkdownInsertion(
      editor,
      markdown.trim() + "\n",
    );
    editor.tf.removeNodes({ at: [index] });
    editor.tf.insertNodes(fragment as never, { at: [index] });
    const saved = save(editor);
    if (choice !== "theirs") expect(saved).toContain("Ours <!-- ours note -->");
    if (choice !== "ours")
      expect(saved).toContain("Theirs\n\n<!-- theirs note -->");
  }
});

test("R4 Routine field value keeps comments when neighbouring text changes", () => {
  // Same calls as `ControlledMarkdownEditor`: value init and onChange.
  const editor = createPlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, pathSource) as never,
  });
  editor.tf.insertText("edited ", { at: pathOfText(editor, "Intro") });
  const changed = editor
    .getApi(MarkdownPlugin)
    .markdown.serialize({ value: editor.children });
  expect(changed).toBe(pathSource.replace("Intro", "edited Intro"));
  expect(save(editor)).toBe(changed);
});

test("R4 toolbar Markdown import inserts comments", () => {
  const editor = editorFor("Existing\n");
  const fragment = deserializeImportedMarkdown(pathSource, (text) =>
    deserializeEditorMarkdownInsertion(editor, text),
  );
  expect(comments(fragment)).toEqual(pathComments);
  editor.tf.insertNodes(fragment as never, { at: [1] });
  expect(save(editor)).toBe(`Existing\n\n${pathSource}`);
});

test("R4 pasted text/plain goes through the editor Markdown boundary", () => {
  const editor = editorFor("Existing\n\nTarget\n");
  editor.tf.select({ path: [1, 0], offset: 6 });
  const data: Record<string, string> = { "text/plain": pathSource };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer);
  expect(comments(editor.children)).toEqual(pathComments);
  expect(save(editor)).toContain(
    "<!-- block -->\n\n- item\n  <!-- in list -->",
  );
});

test("R4 the editor Markdown boundary is the paste parser", () => {
  const editor = editorFor();
  const parser = editor.getPlugin(MarkdownPlugin).parser!;
  const pasted = parser.deserialize!({
    data: pathSource,
    editor,
  } as never);
  expect(pasted).toEqual(deserializeEditorMarkdownSegment(editor, pathSource));
});

// R5: edits next to a comment and edits of the comment marker.
test("R5 typing, formatting, splitting and deleting next to comments keep them", () => {
  const source = "Alpha <!-- a --> beta\n\n<!-- block -->\n\nGamma.Delta\n";
  const editor = editorFor(source);
  editor.tf.insertText("X", { at: pathOfText(editor, "beta") });
  editor.tf.select({
    anchor: pathOfText(editor, "Gamma"),
    focus: { ...pathOfText(editor, "Gamma"), offset: 5 },
  });
  editor.tf.toggleMark(BoldPlugin.key);
  editor.tf.select(pathOfText(editor, "Delta"));
  editor.tf.insertBreak();
  editor.tf.delete({
    at: {
      anchor: pathOfText(editor, "Alpha"),
      focus: { ...pathOfText(editor, "Alpha"), offset: 2 },
    },
  });
  expect(save(editor)).toBe(
    "pha <!-- a --> Xbeta\n\n<!-- block -->\n\n**Gamma**.\n\nDelta\n",
  );
});

test("R5 Slate normalization around inline markers adds nothing to the file", () => {
  const source =
    "See <!-- c -->\n\n<!-- a --><!-- b -->\n\n- <!-- lead -->\n\nEnd\n";
  const editor = editorFor(source);
  editor.tf.normalize({ force: true });
  expect(save(editor)).toBe(source);
});

test("R5 deleting a marker removes exactly that comment and Undo restores it", () => {
  const source = "Alpha <!-- a --> beta\n\n<!-- block -->\n\nGamma\n";
  const editor = editorFor(source);
  editor.tf.select(pathOfText(editor, " beta"));
  editor.tf.deleteBackward("character");
  expect(save(editor)).toBe("Alpha  beta\n\n<!-- block -->\n\nGamma\n");
  editor.tf.removeNodes({ at: [1] });
  expect(save(editor)).toBe("Alpha  beta\n\nGamma\n");
  editor.undo();
  editor.undo();
  expect(save(editor)).toBe(source);
  expect(comments(editor.children)).toEqual(["<!-- a -->", "<!-- block -->"]);
});

test("R5 deleting a selection or the block around a marker removes its comment", () => {
  const source = "One <!-- a --> two\n\nThree <!-- b --> four\n\nFive\n";
  const editor = editorFor(source);
  editor.tf.select({
    anchor: { ...pathOfText(editor, "One"), offset: 3 },
    focus: { ...pathOfText(editor, " two"), offset: 1 },
  });
  editor.tf.deleteFragment();
  expect(save(editor)).toBe("Onetwo\n\nThree <!-- b --> four\n\nFive\n");
  editor.tf.removeNodes({ at: [1] });
  expect(save(editor)).toBe("Onetwo\n\nFive\n");
  editor.undo();
  editor.undo();
  expect(save(editor)).toBe(source);
});

test("R5 copy and paste of a marker inside the editor keeps its text", () => {
  const editor = editorFor("One <!-- a\n  b --> two\n\nTarget\n");
  const fragment = editor.api.fragment({
    anchor: pathOfText(editor, "One"),
    focus: { ...pathOfText(editor, " two"), offset: 4 },
  });
  editor.tf.select({ ...pathOfText(editor, "Target"), offset: 6 });
  editor.tf.insertFragment(fragment);
  expect(save(editor)).toBe(
    "One <!-- a\n  b --> two\n\nTargetOne <!-- a\n  b --> two\n",
  );
});

// R6: an unclosed `<!--` is not a comment and loses no text after it.
for (const [name, source, texts] of [
  [
    "block start",
    "one\n\n<!-- unclosed\n\ntwo\n\nthree\n",
    ["one", "<!-- unclosed", "two", "three"],
  ],
  ["inline", "one <!-- unclosed\n\ntwo\n", ["one <!-- unclosed", "two"]],
  [
    "after a comment",
    "<!-- valid -->\n\npara\n\n<!-- unclosed\n\ntail\n",
    ["para", "<!-- unclosed", "tail"],
  ],
] as const) {
  test(`R6 unclosed comment opener: ${name}`, () => {
    const editor = editorFor(source);
    const blocks = editor.children.map((node) => NodeApi.string(node));
    expect(blocks.filter(Boolean)).toEqual([...texts]);
    expect(comments(editor.children)).toEqual(
      name === "after a comment" ? ["<!-- valid -->"] : [],
    );
    const saved = save(editor);
    expect(save(editorFor(saved))).toBe(saved);
  });
}

test("R6 an unclosed opener inside code is left to the code", () => {
  const source = "```\n<!-- not closed\n```\n\nafter\n";
  const editor = editorFor(source);
  expect(save(editor)).toBe(source);
});

test("the htmlToJsx replay maps rewritten offsets back to the source", () => {
  const source = "a <!-- x --> <br> <input disabled> `<!-- y -->` end";
  const mapped = mapHtmlToJsx(source)!;
  expect(mapped.text).toBe(htmlToJsx(source));
  for (const token of ["a", "x", "end"]) {
    expect(mapped.toInput(mapped.text.indexOf(token))).toBe(
      source.indexOf(token),
    );
  }
  const start = mapped.text.indexOf("{/*");
  const end = mapped.text.indexOf("*/}") + 3;
  expect(source.slice(mapped.toInput(start), mapped.toInput(end))).toBe(
    "<!-- x -->",
  );
});
