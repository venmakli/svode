import { expect, test } from "bun:test";
import { BoldPlugin } from "@platejs/basic-nodes/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type Descendant, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import type { ConflictElement } from "../src/features/editor/conflict/parse-conflicts";
import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
  MARKDOWN_INLINE_LINK_DEFINITION_KEY,
  MARKDOWN_LINK_DEFINITION_KEY,
} from "../src/features/editor/model/markdown-comments";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
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

function rawOf(nodes: Descendant[], types: string[]): string[] {
  const found: string[] = [];
  const visit = (node: Descendant) => {
    const element = node as TElement & { raw?: string };
    if (types.includes(element.type)) found.push(element.raw ?? "");
    for (const child of (element.children ?? []) as Descendant[]) visit(child);
  };
  nodes.forEach(visit);
  return found;
}

const definitions = (nodes: Descendant[]) =>
  rawOf(nodes, [
    MARKDOWN_LINK_DEFINITION_KEY,
    MARKDOWN_INLINE_LINK_DEFINITION_KEY,
  ]);
const comments = (nodes: Descendant[]) =>
  rawOf(nodes, [MARKDOWN_COMMENT_KEY, MARKDOWN_INLINE_COMMENT_KEY]);

function pathOfText(editor: Editor, text: string) {
  for (const [node, path] of NodeApi.texts(editor)) {
    const offset = node.text.indexOf(text);
    if (offset !== -1) return { path, offset };
  }
  throw new Error(`text not found: ${text}`);
}

// DF-211 acceptance 1, definitions. Each source is in house style, so
// load → save gives it back byte for byte.
const corpus: Record<string, { source: string; definitions: string[] }> = {
  unused: {
    source: "Text.\n\n[unused]: https://unused.dev\n",
    definitions: ["[unused]: https://unused.dev"],
  },
  groupAtEnd: {
    source:
      "Text.\n\n[a]: https://a.dev\n[b]: https://b.dev\n[c]: https://c.dev\n",
    definitions: [
      "[a]: https://a.dev",
      "[b]: https://b.dev",
      "[c]: https://c.dev",
    ],
  },
  repeatedLabel: {
    source: "[a]: https://first.dev\n[a]: https://second.dev\n\nText.\n",
    definitions: ["[a]: https://first.dev", "[a]: https://second.dev"],
  },
  titleForms: {
    source:
      "[q]: https://q.dev \"double\"\n[s]: https://s.dev 'single'\n[p]: https://p.dev (paren)\n",
    definitions: [
      '[q]: https://q.dev "double"',
      "[s]: https://s.dev 'single'",
      "[p]: https://p.dev (paren)",
    ],
  },
  angleDestination: {
    source: '[a]: <https://a.dev/with space> "T"\n[e]: <>\n',
    definitions: ['[a]: <https://a.dev/with space> "T"', "[e]: <>"],
  },
  multiline: {
    source: '# Head\n\n[m]:\n  https://m.dev\n  "title\n  on two lines"\n',
    definitions: ['[m]:\n  https://m.dev\n  "title\n  on two lines"'],
  },
  escapedLabel: {
    source: "[a\\]b]: https://a.dev\n",
    definitions: ["[a\\]b]: https://a.dev"],
  },
  pageLink: {
    source: "[plan]: ./plan.md\n",
    definitions: ["[plan]: ./plan.md"],
  },
  bulletList: {
    source: "- one\n\n  [d]: https://d.dev\n- two\n",
    definitions: ["[d]: https://d.dev"],
  },
  listLead: {
    source: "- [l1]: https://l1.dev\n  [l2]: https://l2.dev\n- two\n",
    definitions: ["[l1]: https://l1.dev", "[l2]: https://l2.dev"],
  },
  nestedList: {
    source: "- a\n  - b\n\n    [n]: https://n.dev\n  - c\n",
    definitions: ["[n]: https://n.dev"],
  },
  orderedList: {
    source: "1. a\n\n   [o]: https://o.dev\n2. b\n3. c\n",
    definitions: ["[o]: https://o.dev"],
  },
  blockquote: {
    source: "> quote\n>\n> [q]: https://q.dev\n> [r]: https://r.dev\n",
    definitions: ["[q]: https://q.dev", "[r]: https://r.dev"],
  },
  afterTable: {
    source: "| A | B |\n| - | - |\n| x | y |\n\n[t]: https://t.dev\n",
    definitions: ["[t]: https://t.dev"],
  },
};

for (const [name, { source, definitions: expected }] of Object.entries(
  corpus,
)) {
  test(`link definition corpus round trip: ${name}`, () => {
    const editor = editorFor(source);
    expect(definitions(editor.children)).toEqual(expected);
    expect(comments(editor.children)).toEqual([]);
    const saved = save(editor);
    expect(saved).toBe(source);
    expect(save(editorFor(saved))).toBe(source);
  });
}

test("a definition next to a comment definition keeps each its own marker", () => {
  const source =
    "[//]: # (comment)\n\n[real]: https://real.dev\n\n<!-- html -->\n";
  const editor = editorFor(source);
  expect(definitions(editor.children)).toEqual(["[real]: https://real.dev"]);
  expect(comments(editor.children)).toEqual([
    "[//]: # (comment)",
    "<!-- html -->",
  ]);
  expect(save(editor)).toBe(source);
});

test("definitions in a group are written without blank lines, other blocks follow house style", () => {
  const editor = editorFor(
    "Para\n\n[a]: https://a.dev\n\n[b]: https://b.dev\n[c]: https://c.dev\nAfter\n",
  );
  const saved = save(editor);
  expect(saved).toBe(
    "Para\n\n[a]: https://a.dev\n[b]: https://b.dev\n[c]: https://c.dev\n\nAfter\n",
  );
  expect(save(editorFor(saved))).toBe(saved);
});

test("definitions inside code are not definitions", () => {
  const source =
    "```\n[c]: https://code.dev\n```\n\n`[i]: https://inline.dev`\n";
  const editor = editorFor(source);
  expect(definitions(editor.children)).toEqual([]);
  expect(save(editor)).toBe(source);
});

test("footnotes are not link definitions and keep their round trip", () => {
  const source = "Text[^1].\n\n[^1]: The note.\n";
  const editor = editorFor(source);
  expect(definitions(editor.children)).toEqual([]);
  expect(save(editor)).toBe(source);
});

// R4: every Markdown → editor value path gives the same definition markers.
const pathSource =
  "Intro\n\n- item\n\n  [in-list]: https://list.dev\n\nEnd\n\n[a]: https://a.dev\n[b]: https://b.dev\n";
const pathDefinitions = [
  "[in-list]: https://list.dev",
  "[a]: https://a.dev",
  "[b]: https://b.dev",
];

test("R4 Page load and watcher reload keep definitions", () => {
  const editor = editorFor("Old text\n");
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, pathSource, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  expect(definitions(editor.children)).toEqual(pathDefinitions);
  expect(save(editor)).toBe(pathSource);
});

test("R4 definitions on both sides of a conflict block stay markers", () => {
  const editor = editorFor(
    "[top]: https://top.dev\n\n<<<<<<< HEAD\nOurs\n=======\nTheirs\n>>>>>>> branch\n\n[end]: https://end.dev\n",
  );
  expect(definitions(editor.children)).toEqual([
    "[top]: https://top.dev",
    "[end]: https://end.dev",
  ]);
});

test("R4 Accept and Edit of a conflict branch keep the branch definitions", () => {
  const conflicted =
    "# Title\n\n<<<<<<< HEAD\nOurs\n\n[o]: https://ours.dev\n=======\nTheirs\n\n[t]: https://theirs.dev\n[u]: https://unused.dev\n>>>>>>> branch\n\n[doc]: https://doc.dev\n";
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
    if (choice !== "theirs") {
      expect(saved).toContain("Ours\n\n[o]: https://ours.dev\n");
    }
    if (choice !== "ours") {
      expect(saved).toContain(
        "Theirs\n\n[t]: https://theirs.dev\n[u]: https://unused.dev\n",
      );
    }
    // The branch definitions and the one after the block form one group.
    expect(saved.endsWith("dev\n[doc]: https://doc.dev\n")).toBe(true);
  }
});

test("R4 Routine field value keeps definitions when neighbouring text changes", () => {
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
});

test("R4 toolbar Markdown import inserts definitions", () => {
  const editor = editorFor("Existing\n");
  const fragment = deserializeImportedMarkdown(pathSource, (text) =>
    deserializeEditorMarkdownInsertion(editor, text),
  );
  expect(definitions(fragment)).toEqual(pathDefinitions);
  editor.tf.insertNodes(fragment as never, { at: [1] });
  expect(save(editor)).toBe(`Existing\n\n${pathSource}`);
});

test("R4 pasted text/plain turns the fragment definitions into markers", () => {
  const editor = editorFor("Existing\n\nTarget\n");
  editor.tf.select({ path: [1, 0], offset: 6 });
  const data: Record<string, string> = { "text/plain": pathSource };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer);
  expect(definitions(editor.children)).toEqual(pathDefinitions);
  expect(save(editor)).toContain(
    "End\n\n[a]: https://a.dev\n[b]: https://b.dev\n",
  );
});

// R5: edits next to a definition and edits of the definition marker.
test("R5 typing and formatting next to definitions keep them", () => {
  const source = "Alpha\n\n[a]: https://a.dev\n[b]: https://b.dev\n\nGamma\n";
  const editor = editorFor(source);
  editor.tf.insertText("X", { at: pathOfText(editor, "Alpha") });
  editor.tf.select({
    anchor: pathOfText(editor, "Gamma"),
    focus: { ...pathOfText(editor, "Gamma"), offset: 5 },
  });
  editor.tf.toggleMark(BoldPlugin.key);
  expect(save(editor)).toBe(
    "XAlpha\n\n[a]: https://a.dev\n[b]: https://b.dev\n\n**Gamma**\n",
  );
});

test("R5 deleting a marker removes exactly that definition and Undo restores it", () => {
  const source = "Alpha\n\n[a]: https://a.dev\n[b]: https://b.dev\n\nGamma\n";
  const editor = editorFor(source);
  editor.tf.removeNodes({ at: [1] });
  expect(save(editor)).toBe("Alpha\n\n[b]: https://b.dev\n\nGamma\n");
  editor.undo();
  expect(save(editor)).toBe(source);
  expect(definitions(editor.children)).toEqual([
    "[a]: https://a.dev",
    "[b]: https://b.dev",
  ]);
});

test("R5 deleting the list item a definition opens removes it", () => {
  const source = "- [l]: https://l.dev\n- two\n";
  const editor = editorFor(source);
  editor.tf.removeNodes({ at: [0] });
  expect(save(editor)).toBe("- two\n");
  editor.undo();
  expect(save(editor)).toBe(source);
});

test("R5 copy and paste of a marker inside the editor keeps its text", () => {
  const editor = editorFor('Alpha\n\n[a]: https://a.dev "T"\n\nTarget\n');
  const fragment = editor.api.fragment({
    anchor: { path: [1, 0], offset: 0 },
    focus: { path: [1, 0], offset: 0 },
  });
  expect(definitions(fragment)).toEqual(['[a]: https://a.dev "T"']);
  editor.tf.insertNodes(fragment as never, { at: [3] });
  expect(save(editor)).toBe(
    'Alpha\n\n[a]: https://a.dev "T"\n\nTarget\n\n[a]: https://a.dev "T"\n',
  );
});
