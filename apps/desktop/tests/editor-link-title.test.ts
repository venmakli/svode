import { expect, test } from "bun:test";
import { unwrapLink, upsertLink } from "@platejs/link";
import { LinkPlugin, submitFloatingLink } from "@platejs/link/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement, type TText } from "platejs";
import { createPlateEditor } from "platejs/react";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import {
  type ConflictElement,
  deserializeWithConflicts,
} from "../src/features/editor/conflict/parse-conflicts";
import { applyLinkUrl } from "../src/features/editor/lib/page-link-editor-actions";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;
type Link = TElement & { url: string; title?: string };

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

function links(editor: Editor): Link[] {
  return [...NodeApi.elements(editor)]
    .filter(([node]) => node.type === "a")
    .map(([node]) => node as Link);
}

function pathOfText(editor: Editor, text: string) {
  const entry = [...NodeApi.texts(editor)].find(([node]) =>
    (node as TText).text.startsWith(text),
  );
  if (!entry) throw new Error(`no text ${text}`);
  return { path: entry[1], offset: 0 };
}

function selectIn(editor: Editor, text: string, offset = 1) {
  const point = pathOfText(editor, text);
  editor.tf.select({ ...point, offset });
}

test("the title of a link is kept on load and save", () => {
  const source = 'See [docs](https://example.com "Docs title") now.\n';
  const editor = editorFor(source);
  expect(links(editor)[0]).toMatchObject({
    url: "https://example.com",
    title: "Docs title",
  });
  expect(save(editor)).toBe(source);
});

// R1: every form of title and every container; the quotes become `"…"`.
for (const [name, source, expected] of [
  ["apostrophes", "[a](https://a.com 'Apos')", '[a](https://a.com "Apos")'],
  ["parentheses", "[b](https://b.com (Paren))", '[b](https://b.com "Paren")'],
  [
    "a Page link with ./",
    '[Plan](./plan.md "Plan title")',
    '[Plan](./plan.md "Plan title")',
  ],
  ["a Page link", '[Plan](plan.md "Plan")', '[Plan](plan.md "Plan")'],
  [
    "an address in <…>",
    '[Draft](<Roadmap Draft.md> "Draft title")',
    '[Draft](<Roadmap Draft.md> "Draft title")',
  ],
  [
    'a " in the title',
    '[q](https://q.com "Say \\"hi\\"") and [r](https://r.com \'it"s\')',
    '[q](https://q.com "Say \\"hi\\"") and [r](https://r.com "it\\"s")',
  ],
  [
    "a link text equal to its URL",
    '[https://x.com](https://x.com "X")',
    '[https://x.com](https://x.com "X")',
  ],
  [
    "formatted link text",
    '[**bold** text](https://b.com "B")',
    '[**bold** text](https://b.com "B")',
  ],
  [
    "a heading",
    '# Head [h](https://h.com "H")',
    '# Head [h](https://h.com "H")',
  ],
  [
    "bullet and nested lists",
    '- item [l](https://l.com "L")\n  - nested [n](https://n.com "N")',
    '- item [l](https://l.com "L")\n  - nested [n](https://n.com "N")',
  ],
  [
    "an ordered list",
    '1. one [o](https://o.com "O")\n2. two [p](https://p.com "P")',
    '1. one [o](https://o.com "O")\n2. two [p](https://p.com "P")',
  ],
  [
    "a quote",
    '> quote [q](https://q.com "Q")',
    '> quote [q](https://q.com "Q")',
  ],
] as const) {
  test(`R1 the title of a link in ${name} is kept`, () => {
    const saved = save(editorFor(`${source}\n`));
    expect(saved).toBe(`${expected}\n`);
    expect(save(editorFor(saved))).toBe(saved);
  });
}

test("R1 the title of a link in a table cell is kept", () => {
  const saved = save(
    editorFor('| A | B |\n| - | - |\n| [c](https://c.com "C") | x |\n'),
  );
  expect(saved).toContain('| [c](https://c.com "C") | x |');
  expect(save(editorFor(saved))).toBe(saved);
});

test("R1 the title of a link next to an image is kept", () => {
  const saved = save(
    editorFor('Pic ![img](a.png "I") and [i](https://i.com "Ti")\n'),
  );
  expect(saved).toContain('[i](https://i.com "Ti")');
  expect(saved).toContain('![img](a.png "I")');
  expect(save(editorFor(saved))).toBe(saved);
});

// R4: links without a title, autolinks, mentions and images are unchanged.
test("R4 links without a title, autolinks, mentions and images are unchanged", () => {
  const source =
    '[docs](https://example.com) and https://bare.com and [@Ann](mention:ann)\n\n[Plan](plan.md)\n\n![img](a.png "I")\n';
  const editor = editorFor(source);
  expect(links(editor).every((link) => !("title" in link))).toBe(true);
  expect(save(editor)).toBe(source);
});

// R2: the title follows the link through edits and goes away with it.
const r2Source = 'Intro [docs](https://example.com "Docs title") end\n';

test("R2 editing and formatting the link text keep the title", () => {
  const editor = editorFor(r2Source);
  editor.tf.insertText("my ", { at: pathOfText(editor, "docs") });
  editor.tf.select({
    anchor: pathOfText(editor, "my docs"),
    focus: { ...pathOfText(editor, "my docs"), offset: 2 },
  });
  editor.tf.addMark("bold", true);
  expect(save(editor)).toBe(
    'Intro [**my** docs](https://example.com "Docs title") end\n',
  );
});

test("R2 a new address from the link toolbar keeps the title", () => {
  const editor = editorFor(r2Source);
  selectIn(editor, "docs");
  editor.setOption(LinkPlugin, "url", "https://other.com");
  editor.setOption(LinkPlugin, "text", "docs");
  submitFloatingLink(editor);
  expect(save(editor)).toBe(
    'Intro [docs](https://other.com "Docs title") end\n',
  );
});

test("R2 repairing a broken Page link keeps the title", () => {
  const editor = editorFor('See [Plan](old.md "Plan title")\n');
  selectIn(editor, "Plan");
  applyLinkUrl(editor, "new.md");
  expect(save(editor)).toBe('See [Plan](new.md "Plan title")\n');
});

test("R2 copy and paste of a link inside the editor keeps the title", () => {
  const editor = editorFor(`${r2Source}\nTarget\n`);
  const fragment = editor.api.fragment({
    anchor: pathOfText(editor, "Intro"),
    focus: { ...pathOfText(editor, " end"), offset: 4 },
  });
  editor.tf.select({ ...pathOfText(editor, "Target"), offset: 6 });
  editor.tf.insertFragment(fragment);
  expect(save(editor)).toBe(
    `${r2Source}\nTargetIntro [docs](https://example.com "Docs title") end\n`,
  );
});

test("R2 unlinking drops the title and Undo brings it back", () => {
  const editor = editorFor(r2Source);
  selectIn(editor, "docs");
  unwrapLink(editor);
  expect(save(editor)).toBe("Intro docs end\n");
  editor.undo();
  expect(save(editor)).toBe(r2Source);
});

test("R2 a link made in the editor has no title", () => {
  const editor = editorFor("Intro text\n");
  editor.tf.select({
    anchor: { ...pathOfText(editor, "Intro"), offset: 6 },
    focus: { ...pathOfText(editor, "Intro"), offset: 10 },
  });
  upsertLink(editor, { url: "https://new.com", skipValidation: true });
  expect(save(editor)).toBe("Intro [text](https://new.com)\n");
});

// R3: the same boundary reads pasted Markdown and the Routine field.
test("R3 pasted text/plain keeps the title", () => {
  const editor = editorFor("Target\n");
  editor.tf.select({ ...pathOfText(editor, "Target"), offset: 6 });
  const data: Record<string, string> = { "text/plain": r2Source };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer);
  expect(save(editor)).toContain('[docs](https://example.com "Docs title")');
});

test("R3 the Routine field keeps the title when nearby text changes", () => {
  // Same calls as `ControlledMarkdownEditor`: value init and onChange.
  const editor = createPlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, r2Source) as never,
  });
  editor.tf.insertText("edited ", { at: pathOfText(editor, "Intro") });
  expect(
    editor
      .getApi(MarkdownPlugin)
      .markdown.serialize({ value: editor.children }),
  ).toBe(`edited ${r2Source}`);
});

test("R3 a reload of the same source keeps the title", () => {
  const editor = editorFor("Before\n");
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, r2Source, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  expect(save(editor)).toBe(r2Source);
});

test("R3 Accept of a conflict branch keeps the title", () => {
  const editor = editorFor(
    '# Title\n\n<<<<<<< HEAD\nOurs [a](https://a.com "A")\n=======\nTheirs [b](b.md "B")\n>>>>>>> branch\n',
  );
  const index = editor.children.findIndex(
    (node) => (node as TElement).type === "conflict",
  );
  const conflict = editor.children[index] as unknown as ConflictElement;
  // Same insertion as `ConflictElementComponent.replaceWithMarkdown`.
  const fragment = deserializeEditorMarkdownInsertion(
    editor,
    `${conflict.ours}\n\n${conflict.theirs}`.trim() + "\n",
  );
  editor.tf.removeNodes({ at: [index] });
  editor.tf.insertNodes(fragment as never, { at: [index] });
  expect(save(editor)).toBe(
    '# Title\n\nOurs [a](https://a.com "A")\n\nTheirs [b](b.md "B")\n',
  );
});
