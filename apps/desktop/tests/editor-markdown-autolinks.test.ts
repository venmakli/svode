import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import {
  type Descendant,
  ElementApi,
  NodeApi,
  type TElement,
  type TText,
  type Value,
} from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import {
  type ConflictElement,
  deserializeWithConflicts,
} from "../src/features/editor/conflict/parse-conflicts";
import {
  deserializeEditorMarkdownInsertion,
  fencedCodeRanges,
} from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

// Page load: the path of `useEditorDocumentLoader`.
function editorFor(source: string, editor = createEditor()): Editor {
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, source, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  return editor;
}

function createEditor(): Editor {
  return createPlateEditor({ plugins: EditorKit });
}

function save(editor: Editor): string {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}

function urls(nodes: Descendant[]): string[] {
  const found: string[] = [];
  const walk = (children: Descendant[]) => {
    for (const node of children) {
      if (!ElementApi.isElement(node)) continue;
      if (node.type === "a") found.push(String(node.url));
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** The text of each top-level block, a trailing empty paragraph left out. */
function blockTexts(nodes: Descendant[]): string[] {
  const last = nodes.at(-1);
  const trailing =
    ElementApi.isElement(last) && last.type === "p" && !NodeApi.string(last);
  return (trailing ? nodes.slice(0, -1) : nodes).map((node) =>
    NodeApi.string(node),
  );
}

function marked(editor: Editor, mark: string): string[] {
  return [...NodeApi.texts(editor)]
    .filter(([node]) => (node as TText & Record<string, unknown>)[mark])
    .map(([node]) => node.text);
}

function hasElement(nodes: Descendant[], type: string): boolean {
  return nodes.some(
    (node) =>
      ElementApi.isElement(node) &&
      (node.type === type || hasElement(node.children, type)),
  );
}

/** Save, load the saved text and save again: the second save is the first. */
function expectStableRoundTrip(editor: Editor) {
  const saved = save(editor);
  const reloaded = editorFor(saved);
  expect(urls(reloaded.children)).toEqual(urls(editor.children));
  expect(blockTexts(reloaded.children)).toEqual(blockTexts(editor.children));
  expect(save(reloaded)).toBe(saved);
  return saved;
}

const evidence = "[A](<Roadmap Draft.md>)\n\nand <https://auto.com>\n";

test("R1 the link with an address in <…> and the autolink paragraph are both read", () => {
  const editor = editorFor(evidence);
  expect(urls(editor.children)).toEqual([
    "Roadmap Draft.md",
    "https://auto.com",
  ]);
  expect(blockTexts(editor.children)).toEqual(["A", "and https://auto.com"]);
  const saved = expectStableRoundTrip(editor);
  expect(saved).toStartWith("[A](<Roadmap Draft.md>)\n\nand ");
  expect(saved).toContain("https://auto.com");
  expect(saved).not.toContain("<br />");
  expect(saved).not.toContain("\\[");
});

// R1: autolinks of any scheme and email, in every container and next to the
// constructs a document reads the same way without them.
const corpus: {
  name: string;
  source: string;
  urls: string[];
  blocks: string[];
  check?: (editor: Editor) => void;
}[] = [
  {
    name: "a link with an address in <…> on the same line",
    source: "[A](<Roadmap Draft.md>) and <https://auto.com>\n",
    urls: ["Roadmap Draft.md", "https://auto.com"],
    blocks: ["A and https://auto.com"],
  },
  {
    name: "a Page link with an address in <…>",
    source: "[A](<Plan.md>)\n\nand <https://auto.com>\n",
    urls: ["Plan.md", "https://auto.com"],
    blocks: ["A", "and https://auto.com"],
  },
  {
    name: "an image with an address in <…>",
    source: "![A](<my img.png>)\n\nand <https://auto.com>\n",
    urls: ["https://auto.com"],
    blocks: ["", "and https://auto.com"],
    check: (editor) => {
      const image = [...NodeApi.elements(editor)].find(
        ([node]) => node.type === "img",
      )?.[0] as (TElement & { url?: string }) | undefined;
      expect(image?.url).toBe("my img.png");
    },
  },
  {
    name: "ftp, mailto and email autolinks",
    source:
      "see <ftp://x.org/f> here\n\nmail <me@example.com>\n\nx <mailto:me@x.org> y\n",
    urls: ["ftp://x.org/f", "mailto:me@example.com", "mailto:me@x.org"],
    blocks: [
      "see ftp://x.org/f here",
      "mail me@example.com",
      "x mailto:me@x.org y",
    ],
  },
  {
    name: "autolinks in a list, quote, table cell and heading",
    source: [
      "- item <https://a.com>",
      "",
      "> quote <me@x.org>",
      "",
      "| a | b |",
      "| --- | --- |",
      "| <https://t.com> | x |",
      "",
      "# Head <ftp://h.org>",
      "",
    ].join("\n"),
    urls: ["https://a.com", "mailto:me@x.org", "https://t.com", "ftp://h.org"],
    blocks: [
      "item https://a.com",
      "quote me@x.org",
      "abhttps://t.comx",
      "Head ftp://h.org",
    ],
  },
  {
    name: "an autolink next to <u>",
    source: "a <u>under</u> b\n\nand <https://auto.com>\n",
    urls: ["https://auto.com"],
    blocks: ["a under b", "and https://auto.com"],
    check: (editor) => expect(marked(editor, "underline")).toEqual(["under"]),
  },
  {
    name: "an autolink next to <kbd>",
    source: "a <kbd>K</kbd> b <https://auto.com>\n",
    urls: ["https://auto.com"],
    blocks: ["a K b https://auto.com"],
    check: (editor) => expect(marked(editor, "kbd")).toEqual(["K"]),
  },
  {
    name: "an autolink inside <callout>",
    source: "<callout>\nhi <https://auto.com>\n</callout>\n",
    urls: ["https://auto.com"],
    blocks: ["hi https://auto.com"],
    check: (editor) =>
      expect(hasElement(editor.children, "callout")).toBe(true),
  },
  {
    name: "an autolink next to comments",
    source: "text <!-- c --> <https://auto.com>\n\n<!-- block -->\n",
    urls: ["https://auto.com"],
    blocks: ["text  https://auto.com", ""],
    check: (editor) => {
      expect(hasElement(editor.children, "markdown_comment_inline")).toBe(true);
      expect(hasElement(editor.children, "markdown_comment")).toBe(true);
      expect(save(editor)).toContain("text <!-- c --> ");
      expect(save(editor)).toContain("\n\n<!-- block -->\n");
    },
  },
  {
    name: "an autolink next to a reference link",
    source: "see [ref][r] <https://auto.com>\n\n[r]: https://r.com\n",
    urls: ["https://r.com", "https://auto.com"],
    blocks: ["see ref https://auto.com", ""],
    check: (editor) => {
      expect(save(editor)).toContain("see [ref][r] ");
      expect(save(editor)).toContain("\n\n[r]: https://r.com\n");
    },
  },
];

for (const entry of corpus) {
  test(`R1 ${entry.name}`, () => {
    const editor = editorFor(entry.source);
    expect(urls(editor.children)).toEqual(entry.urls);
    expect(blockTexts(editor.children)).toEqual(entry.blocks);
    entry.check?.(editor);
    expect(save(editor)).not.toContain("<br />");
    expectStableRoundTrip(editor);
  });
}

// R3: text MDX rejects is read whole, not cut by Plate's fallback for
// streamed MDX.
const rejected: { source: string; blocks: string[] }[] = [
  {
    source: "first para\n\nx a<b y\n\nlast para\n",
    blocks: ["first para", "x a<b y", "last para"],
  },
  { source: "x <= y\n\nnext\n", blocks: ["x <= y", "next"] },
  { source: "I <3 it\n\nnext\n", blocks: ["I <3 it", "next"] },
  { source: "text <div> more\n\nnext\n", blocks: ["text <div> more", "next"] },
  { source: "line a<b\nnext line\n", blocks: ["line a<b\nnext line"] },
];

for (const { source, blocks } of rejected) {
  test(`R3 ${JSON.stringify(source)} keeps every block and space`, () => {
    const editor = editorFor(source);
    expect(blockTexts(editor.children)).toEqual(blocks);
    expect(save(editor)).not.toContain("<br />");
    expectStableRoundTrip(editor);
  });
}

test("R3 a document MDX rejects keeps its links, definitions and code", () => {
  const source = [
    "x a<b y and [A](<Roadmap Draft.md>) <me@x.org>",
    "",
    "see [x][r] and `\\<b>`",
    "",
    "[r]: https://r.com",
    "",
    "```html",
    "<div> \\<i>",
    "```",
    "",
    "last",
    "",
  ].join("\n");
  const editor = editorFor(source);
  expect(urls(editor.children)).toEqual([
    "Roadmap Draft.md",
    "mailto:me@x.org",
    "https://r.com",
  ]);
  expect(blockTexts(editor.children)).toEqual([
    "x a<b y and A me@x.org",
    "see x and \\<b>",
    "",
    "<div> \\<i>",
    "last",
  ]);
  const saved = expectStableRoundTrip(editor);
  expect(saved).toContain("\n\n[r]: https://r.com\n\n");
  expect(saved).toContain("```html\n<div> \\<i>\n```");
});

// R5: every Markdown → editor value path reads the same way.
const pathSource = "[A](<Plan.md>) <https://auto.com>\n\nx a<b y\n\nEnd\n";

function expectPathRead(nodes: Descendant[]) {
  expect(urls(nodes)).toEqual(["Plan.md", "https://auto.com"]);
  expect(blockTexts(nodes).slice(-3)).toEqual([
    "A https://auto.com",
    "x a<b y",
    "End",
  ]);
}

test("R5 watcher reload into an open editor", () => {
  const editor = editorFor("Old text\n");
  editorFor(pathSource, editor);
  expectPathRead(editor.children);
});

test("R5 the document around a conflict and Accept/Edit of its sides", () => {
  const conflicted = [
    "<https://before.com> and [A](<Plan.md>)",
    "",
    "<<<<<<< HEAD",
    "Ours <me@x.org> and [B](<Roadmap Draft.md>)",
    "=======",
    "Theirs x a<b y",
    "",
    "next <ftp://x.org>",
    ">>>>>>> branch",
    "",
    "after a <u>u</u> <https://after.com>",
    "",
  ].join("\n");
  const editor = editorFor(conflicted);
  expect(urls(editor.children)).toEqual([
    "https://before.com",
    "Plan.md",
    "https://after.com",
  ]);
  expect(marked(editor, "underline")).toEqual(["u"]);
  const index = editor.children.findIndex(
    (node) => (node as TElement).type === "conflict",
  );
  const conflict = editor.children[index] as unknown as ConflictElement;
  for (const choice of ["ours", "theirs", "edit"] as const) {
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
    const texts = blockTexts(fragment);
    if (choice !== "theirs") {
      expect(urls(fragment)).toContain("mailto:me@x.org");
      expect(urls(fragment)).toContain("Roadmap Draft.md");
      expect(texts).toContain("Ours me@x.org and B");
    }
    if (choice !== "ours") {
      expect(urls(fragment)).toContain("ftp://x.org");
      expect(texts).toContain("Theirs x a<b y");
      expect(texts).toContain("next ftp://x.org");
    }
  }
});

test("R5 toolbar Markdown import", () => {
  const editor = editorFor("Existing\n");
  expectPathRead(
    deserializeImportedMarkdown(pathSource, (text) =>
      deserializeEditorMarkdownInsertion(editor, text),
    ),
  );
});

test("R5 pasted text/plain", () => {
  const editor = editorFor("Existing\n\nTarget\n");
  editor.tf.select({ path: [1, 0], offset: 6 });
  const data: Record<string, string> = { "text/plain": pathSource };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer);
  expect(urls(editor.children)).toEqual(["Plan.md", "https://auto.com"]);
  const texts = blockTexts(editor.children).join("\n");
  expect(texts).toContain("x a<b y");
  expect(texts).toContain("End");
});

test("R5 Routine field value", () => {
  // Same calls as `ControlledMarkdownEditor`: value init.
  const editor = createPlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, pathSource) as Value,
  });
  expectPathRead(editor.children);
});

test("R5 code blocks for conflicts are found as the document is read", () => {
  const editor = createEditor();
  // With MDX the fence inside <callout> is code; without it, part of an HTML
  // block.
  const source = "<callout>\n```\nx\n```\n</callout>\n\nsee <https://a.com>\n";
  const start = source.indexOf("```");
  const end = source.lastIndexOf("```") + 3;
  expect(fencedCodeRanges(editor, source)).toEqual([{ start, end }]);
  expect(hasElement(editorFor(source).children, "code_block")).toBe(true);
});
