import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import type { ConflictElement } from "../src/features/editor/conflict/parse-conflicts";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

const crlf = (source: string) => source.replaceAll("\n", "\r\n");

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

function valueText(editor: Editor): string {
  return JSON.stringify(editor.children);
}

// LF sources; each is also read with every line ending as CRLF.
const corpus: Record<string, string> = {
  paragraphs: "First para\n\nSecond para\n",
  softBreak: "line one\nline two\n",
  breakAfterLink: "a [link](x.md)\nb\n",
  bareBreak: "text<br>\nnext\n",
  blockquote: "> q1\n> q2\n",
  list: "- a\n  b\n- c\n  - nested\n    more\n",
  codeBlock: "```ts\nconst a = 1;\n\nconst b = 2;\n```\n",
  math: "$$\na + b\n= c\n$$\n",
  table: "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
  comment: "<!-- one\ntwo -->\n\nText\n\n{/* three\nfour */}\n",
  literal:
    "Intro `code\nmore` and $x\ny$ end\n\n```html\n<br>\n<input disabled>\n```\n",
};

for (const [name, lf] of Object.entries(corpus)) {
  test(`${name}: CRLF reads as LF and saves without CR`, () => {
    const lfEditor = editorFor(lf);
    const crlfEditor = editorFor(crlf(lf));
    expect(crlfEditor.children).toEqual(lfEditor.children);
    expect(valueText(crlfEditor)).not.toContain("\\r");

    const saved = save(crlfEditor);
    expect(saved).toBe(save(lfEditor));
    expect(saved).not.toContain("\r");

    const again = editorFor(saved);
    expect(save(again)).toBe(saved);
  });
}

test("CRLF in a mixed document is read as LF", () => {
  const lf = Object.values(corpus).join("\n");
  const mixed = lf
    .split("\n")
    .map((line, index) => line + (index % 2 ? "\r\n" : "\n"))
    .join("")
    .slice(0, -1);
  expect(save(editorFor(mixed))).toBe(save(editorFor(lf)));
});

test("Accept and Edit of a CRLF conflict give the value of the LF conflict", () => {
  const lf =
    "# Title\n\n<<<<<<< HEAD\nOurs line\nsoft break\n\n```\na\nb\n```\n=======\n> Theirs\n> quote\n>>>>>>> branch\n";
  const accept = (source: string, choice: "ours" | "theirs" | "edit") => {
    const editor = editorFor(source);
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
    return editor;
  };
  for (const choice of ["ours", "theirs", "edit"] as const) {
    const fromCrlf = accept(crlf(lf), choice);
    const fromLf = accept(lf, choice);
    expect(valueText(fromCrlf)).not.toContain("\\r");
    expect(save(fromCrlf)).toBe(save(fromLf));
    expect(save(fromCrlf)).not.toContain("\r");
  }
});

test("Routine field with a CRLF value gives the value of the LF field", () => {
  const lf = "Step one\nstill one\n\n```sh\necho a\necho b\n```\n";
  // Same calls as `ControlledMarkdownEditor`: value init and onChange.
  const edited = (value: string) => {
    const editor = createPlateEditor({
      plugins: EditorKit,
      value: (instance) =>
        deserializeEditorMarkdownInsertion(instance, value) as never,
    });
    const [, path] = [...NodeApi.texts(editor)].find(([node]) =>
      node.text.startsWith("Step"),
    )!;
    editor.tf.insertText("First ", { at: { path, offset: 0 } });
    return editor
      .getApi(MarkdownPlugin)
      .markdown.serialize({ value: editor.children });
  };
  const changed = edited(crlf(lf));
  expect(changed).not.toContain("\r");
  expect(changed).toBe(edited(lf));
});

test("pasted CRLF Markdown gives the value of LF Markdown", () => {
  const paste = (text: string) => {
    const editor = editorFor("Existing\n\nTarget\n");
    editor.tf.select({ path: [1, 0], offset: 6 });
    const data: Record<string, string> = { "text/plain": text };
    editor.tf.insertData({
      files: [] as unknown as FileList,
      getData: (type: string) => data[type] ?? "",
      types: Object.keys(data),
    } as unknown as DataTransfer);
    return editor;
  };
  const lf = "Pasted line\nsoft break\n\n```\ncode\nlines\n```\n";
  const fromCrlf = paste(crlf(lf));
  expect(valueText(fromCrlf)).not.toContain("\\r");
  expect(save(fromCrlf)).toBe(save(paste(lf)));
});
