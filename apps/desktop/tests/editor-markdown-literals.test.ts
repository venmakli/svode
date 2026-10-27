import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import type { ConflictElement } from "../src/features/editor/conflict/parse-conflicts";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
} from "../src/features/editor/model/markdown-comments";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { restoreMarkdownLiteral } from "../src/features/editor/model/markdown-literals";
import {
  createMarkdownSourceView,
  mapHtmlToJsx,
  type MdastNode,
} from "../src/features/editor/model/markdown-source";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

function editorFor(source = ""): Editor {
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

function commentCount(editor: Editor): number {
  return [...NodeApi.elements(editor)].filter(([node]) =>
    [MARKDOWN_COMMENT_KEY, MARKDOWN_INLINE_COMMENT_KEY].includes(node.type),
  ).length;
}

// Code and literal text that Plate's `htmlToJsx` rewrote before DF-168C. Each
// source is already in house style, so load → save must give it back byte for
// byte.
const corpus: Record<string, string> = {
  fencedHtml:
    "```html\n<!-- in code -->\n<div class=a><label for=b>x</label><input disabled><br></div>\n```\n",
  inlineCode:
    "Inline `<!-- x -->` and `<div class=a>` and `<label for=b>` and `<input disabled>` and `<br>`\n",
  escapedComment: "Escaped \\<!-- not a comment --> text\n",
  escapedTags: "Escaped \\<div class=a> and \\<input disabled> and \\<br>\n",
  multilineTagInFence: "```html\n<div\n  class=a\n>\n```\n",
  longerFence: "````\n<br>\n```\n````\n",
  fenceInBlockquote: "> ```html\n> <input disabled>\n> ```\n",
  inlineCodeInList: "- item `<br>`\n  - nested `<input disabled>`\n",
  taskAndHeading: "# Head `<input disabled>` \\<br>\n\n- [ ] task `<br>`\n",
  tableCell:
    "| A         | B       |\n| --------- | ------- |\n| `a\\|<br>` | b \\<br> |\n",
  footnote: "Note[^1]\n\n[^1]: foot \\<b> `<br>`\n",
  math: "Math $a<b>c$ and\n\n$$\nx <br> \\<b>\n$$\n",
  backslashes: "a \\< b and `\\<b>` and `\\\\<b>`\n",
  withComments: "<!-- c --> `<!-- inline -->` \\<!-- e -->\n",
};

for (const [name, source] of Object.entries(corpus)) {
  test(`literal corpus round trip: ${name}`, () => {
    const saved = save(editorFor(source));
    expect(saved).toBe(source);
    expect(save(editorFor(saved))).toBe(source);
  });
}

test("code and escaped text in the editor value keep the source characters", () => {
  const editor = editorFor(
    "```html\n<input disabled>\n```\n\n`<br>` and \\<b class=x>\n",
  );
  const [block, paragraph] = editor.children as TElement[];
  expect(NodeApi.string(block)).toBe("<input disabled>");
  expect(NodeApi.string(paragraph)).toBe("<br> and <b class=x>");
});

test("comments inside code and escaped comments are not comments", () => {
  const editor = editorFor(
    "```\n<!-- a -->\n```\n\n`<!-- b -->` \\<!-- c --> <!-- d -->\n",
  );
  expect(commentCount(editor)).toBe(1);
});

test("an escaped opener does not swallow the comment after it", () => {
  const source = "\\<!-- a <!-- b -->\n";
  const editor = editorFor(source);
  expect(commentCount(editor)).toBe(1);
  expect(save(editor)).toBe(source);
});

test("CRLF fenced code keeps its characters", () => {
  const editor = editorFor("```html\r\n<input disabled>\r\n<br>\r\n```\r\n");
  // Plate itself splits code lines at `\n` only; the HTML stays as written.
  const saved = save(editor);
  expect(saved).toContain("<input disabled>");
  expect(saved).toContain("<br>");
  expect(saved).not.toContain("/>");
});

test("a document Plate parses without MDX keeps Plate's own code handling", () => {
  // `{a: 1}` is not valid MDX, so Plate falls back to its parse without MDX.
  const editor = editorFor("text {a: 1} and `\\<b>` code\n");
  expect(save(editor)).not.toContain("&lt;");
  expect(NodeApi.string(editor)).toContain("\\<b>");
});

test("a literal is left as Plate made it when its value cannot be replayed", () => {
  const source = "`<br>`";
  const parsed = mapHtmlToJsx(source)!;
  const view = createMarkdownSourceView(source, parsed);
  const node = (value: string): MdastNode => ({
    type: "inlineCode",
    value,
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: parsed.text.length },
    },
  });
  const restored = node("<br />");
  restoreMarkdownLiteral(restored, [], view);
  expect(restored.value).toBe("<br>");
  const unknown = node("other");
  restoreMarkdownLiteral(unknown, [], view);
  expect(unknown.value).toBe("other");
});

// R4: every Markdown → editor value path gives the same literals.
const pathSource =
  "Intro `<br>` \\<b class=x>\n\n```html\n<!-- c --> <input disabled>\n```\n\nEnd\n";

test("R4 Page load and watcher reload keep code and escaped text", () => {
  const editor = editorFor("Old text\n");
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, pathSource, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  expect(save(editor)).toBe(pathSource);
});

test("R4 Accept and Edit of a conflict branch keep code and escaped text", () => {
  const conflicted =
    "# Title\n\n<<<<<<< HEAD\nOurs `<br>`\n=======\nTheirs \\<b class=x>\n\n```\n<input disabled>\n```\n>>>>>>> branch\n";
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
    if (choice !== "theirs") expect(saved).toContain("Ours `<br>`");
    if (choice !== "ours") {
      expect(saved).toContain(
        "Theirs \\<b class=x>\n\n```\n<input disabled>\n```",
      );
    }
  }
});

test("R4 Routine field value keeps code when neighbouring text changes", () => {
  // Same calls as `ControlledMarkdownEditor`: value init and onChange.
  const editor = createPlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, pathSource) as never,
  });
  const [, path] = [...NodeApi.texts(editor)].find(([node]) =>
    node.text.startsWith("End"),
  )!;
  editor.tf.insertText("The ", { at: { path, offset: 0 } });
  const changed = editor
    .getApi(MarkdownPlugin)
    .markdown.serialize({ value: editor.children });
  expect(changed).toBe(pathSource.replace("End", "The End"));
});

test("R4 toolbar Markdown import keeps code and escaped text", () => {
  const editor = editorFor("Existing\n");
  const fragment = deserializeImportedMarkdown(pathSource, (text) =>
    deserializeEditorMarkdownInsertion(editor, text),
  );
  editor.tf.insertNodes(fragment as never, { at: [1] });
  expect(save(editor)).toBe(`Existing\n\n${pathSource}`);
});

test("R4 pasted text/plain keeps code and escaped text", () => {
  const editor = editorFor("Existing\n\nTarget\n");
  editor.tf.select({ path: [1, 0], offset: 6 });
  const data: Record<string, string> = { "text/plain": pathSource };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer);
  const saved = save(editor);
  expect(saved).toContain("`<br>` \\<b class=x>");
  expect(saved).toContain("```html\n<!-- c --> <input disabled>\n```");
});
