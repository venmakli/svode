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

function createEditor(): Editor {
  return createPlateEditor({ plugins: EditorKit });
}

// Page load: the path of `useEditorDocumentLoader`.
function editorFor(source: string, editor = createEditor()): Editor {
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, source, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  return editor;
}

function save(editor: Editor): string {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
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

function marked(nodes: Descendant[], mark: string): string[] {
  const found: string[] = [];
  const walk = (children: Descendant[]) => {
    for (const node of children) {
      if (ElementApi.isElement(node)) walk(node.children);
      else if ((node as TText & Record<string, unknown>)[mark]) {
        found.push((node as TText).text);
      }
    }
  };
  walk(nodes);
  return found;
}

function elements(nodes: Descendant[], type: string): TElement[] {
  const found: TElement[] = [];
  const walk = (children: Descendant[]) => {
    for (const node of children) {
      if (!ElementApi.isElement(node)) continue;
      if (node.type === type) found.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

function urls(nodes: Descendant[]): string[] {
  return elements(nodes, "a").map((link) => String(link.url));
}

/** Save, load the saved text and save again: the second save is the first. */
function expectStableRoundTrip(editor: Editor): string {
  const saved = save(editor);
  const reloaded = editorFor(saved);
  expect(blockTexts(reloaded.children)).toEqual(blockTexts(editor.children));
  expect(save(reloaded)).toBe(saved);
  return saved;
}

/** The MDX elements of `nodes` are elements, not text with tags. */
function expectMdxElements(nodes: Descendant[]) {
  expect(marked(nodes, "underline")).toEqual(["under"]);
  expect(marked(nodes, "kbd")).toEqual(["K"]);
  expect(elements(nodes, "callout")).toHaveLength(1);
  expect(elements(nodes, "markdown_comment_inline")).toHaveLength(1);
  expect(elements(nodes, "markdown_comment")).toHaveLength(1);
}

// The MDX elements of the R2 corpus: each line is read as without the R2
// text next to it.
const mdxLines = [
  "a <u>under</u> b",
  "",
  "press <kbd>K</kbd> now",
  "",
  "<callout>",
  "inside",
  "</callout>",
  "",
  "text <!-- c --> after",
  "",
  "<!-- block -->",
];
const mdxTexts = ["a under b", "press K now", "inside", "text  after", ""];

// R2: `<` and `{` MDX rejects, each as text CommonMark reads at its place.
const rejected: { name: string; line: string; text?: string }[] = [
  { name: "a < before a letter", line: "x a<b y" },
  { name: "a < before =", line: "x <= y" },
  { name: "a < before a digit", line: "I <3 it" },
  { name: "a < at the end of a line", line: "ends a<" },
  { name: "a tag without its pair", line: "text <div> more" },
  { name: "a closing tag without its opener", line: "text </div> more" },
  { name: "tags that do not pair", line: "a <b>x</i> c" },
  { name: "a { without its }", line: "open { only" },
  { name: "a { that opens no expression", line: "a {b c} d" },
  // `{c}` is an MDX expression, which Plate drops with its text (outside
  // DF-274): only the `{` without its `}` is read as text.
  {
    name: "nested braces without the last }",
    line: "a { b {c} d",
    text: "a { b  d",
  },
  { name: "a < at the start of a line", line: "<= x and <3" },
  { name: "a tag at the start of a line", line: "<div> more" },
  { name: "an unclosed comment opener", line: "one <!-- unclosed" },
];

for (const { name, line, text = line } of rejected) {
  for (const [where, source, texts] of [
    [
      "before the MDX elements",
      [line, "", ...mdxLines, ""].join("\n"),
      [text, ...mdxTexts],
    ],
    [
      "after the MDX elements",
      [...mdxLines, "", line, ""].join("\n"),
      [...mdxTexts, text],
    ],
    [
      "between and inside the MDX elements",
      [
        `${line} <u>under</u>`,
        "",
        `<kbd>K</kbd> ${line}`,
        "",
        "<callout>",
        line,
        "</callout>",
        "",
        `<!-- c --> ${line} <!-- not closed`,
        "",
        "<!-- block -->",
        "",
      ].join("\n"),
      [`${text} under`, `K ${text}`, text, ` ${text} <!-- not closed`, ""],
    ],
  ] as const) {
    test(`R2 ${name} ${where}: text, and MDX elements elements`, () => {
      const editor = editorFor(source);
      expect(blockTexts(editor.children)).toEqual([...texts]);
      expectMdxElements(editor.children);
      expect(save(editor)).not.toContain("<br />");
      expectStableRoundTrip(editor);
    });
  }
}

test("R2 a comment after a < that opens no tag stays a comment", () => {
  // MDX reads the comment as an attribute expression of the tag `<b y`.
  const editor = editorFor("x a<b y <!-- c --> z\n");
  expect(blockTexts(editor.children)).toEqual(["x a<b y  z"]);
  expect(
    elements(editor.children, "markdown_comment_inline").map(
      (comment) => (comment as TElement & { raw: string }).raw,
    ),
  ).toEqual(["<!-- c -->"]);
  expectStableRoundTrip(editor);
});

test("R2 destinations in <…> stay destinations next to R2 text", () => {
  const source =
    "[A](<5 a.md>) x <= y { open\n\nsee [r][r] I <3\n\n[r]: <1 r.md>\n";
  const editor = editorFor(source);
  expect(urls(editor.children)).toEqual(["5 a.md", "1 r.md"]);
  expect(blockTexts(editor.children)).toEqual([
    "A x <= y { open",
    "see r I <3",
    "",
  ]);
  const saved = expectStableRoundTrip(editor);
  expect(saved).toContain("[A](<5 a.md>)");
  expect(saved).toContain("see [r][r] ");
  expect(saved).toContain("[r]: <1 r.md>");
});

test("R2 places in list items, quotes, headings and table cells", () => {
  const source = [
    "- item a<b <u>under</u>",
    "  - nested x <= y { open",
    "",
    "> quote I <3 it <kbd>K</kbd>",
    "",
    "# Head text <div> more",
    "",
    "| a<b | x <= y |",
    "| --- | --- |",
    "| {c | <span> |",
    "",
  ].join("\n");
  const editor = editorFor(source);
  expect(blockTexts(editor.children)).toEqual([
    "item a<b under",
    "nested x <= y { open",
    "quote I <3 it K",
    "Head text <div> more",
    "a<bx <= y{c<span>",
  ]);
  expect(marked(editor.children, "underline")).toEqual(["under"]);
  expect(marked(editor.children, "kbd")).toEqual(["K"]);
  expectStableRoundTrip(editor);
});

test("R2 code keeps its < and { and the rest keeps MDX", () => {
  const source = [
    "x a<b y and `a<b {c` $x<=y$ I <3 <u>under</u>",
    "",
    "```js",
    "if (a<b) {",
    "",
    "  x <= y",
    "```",
    "",
    "$$",
    "a<b {",
    "$$",
    "",
  ].join("\n");
  const editor = editorFor(source);
  expect(marked(editor.children, "underline")).toEqual(["under"]);
  const saved = expectStableRoundTrip(editor);
  expect(saved).toContain("`a<b {c` $x<=y$ I ");
  expect(saved).toContain("```js\nif (a<b) {\n\n  x <= y\n```");
  expect(saved).toContain("$$\na<b {\n$$");
});

test("R2 an element of the flow closed after blank lines stays an element", () => {
  const source = [
    "<callout>",
    "",
    "x a<b y",
    "",
    "{ open",
    "",
    "</callout>",
    "",
    "<!--",
    "",
    "a<b",
    "",
    "-->",
    "",
  ].join("\n");
  const editor = editorFor(source);
  const [callout] = elements(editor.children, "callout");
  expect(callout).toBeDefined();
  expect(blockTexts(callout!.children)).toEqual(["x a<b y", "{ open"]);
  expect(
    elements(editor.children, "markdown_comment").map(
      (comment) => (comment as TElement & { raw: string }).raw,
    ),
  ).toEqual(["<!--\n\na<b\n\n-->"]);
  expectStableRoundTrip(editor);
});

test("R1 an autolink at the start of a line is a link next to MDX elements", () => {
  const source = [
    "<https://a.com> and <u>under</u>",
    "",
    "first line",
    "<me@x.org> on the next",
    "",
    "- <ftp://x.org/f> item",
    "",
    "> <https://q.com> x a<b",
    "",
  ].join("\n");
  const editor = editorFor(source);
  expect(urls(editor.children)).toEqual([
    "https://a.com",
    "mailto:me@x.org",
    "ftp://x.org/f",
    "https://q.com",
  ]);
  expect(marked(editor.children, "underline")).toEqual(["under"]);
  expect(blockTexts(editor.children)).toEqual([
    "https://a.com and under",
    "first line\nme@x.org on the next",
    "ftp://x.org/f item",
    "https://q.com x a<b",
  ]);
  expectStableRoundTrip(editor);
});

// R5: every Markdown → editor value path reads R2 text the same way.
const pathSource = "x a<b y <u>under</u>\n\nopen { only <kbd>K</kbd>\n\nEnd\n";

function expectPathRead(nodes: Descendant[]) {
  expect(blockTexts(nodes).slice(-3)).toEqual([
    "x a<b y under",
    "open { only K",
    "End",
  ]);
  expect(marked(nodes, "underline")).toEqual(["under"]);
  expect(marked(nodes, "kbd")).toEqual(["K"]);
}

test("R5 watcher reload into an open editor", () => {
  const editor = editorFor("Old text\n");
  editorFor(pathSource, editor);
  expectPathRead(editor.children);
});

test("R5 the document around a conflict and Accept/Edit of its sides", () => {
  const conflicted = [
    "before a<b <u>under</u>",
    "",
    "<<<<<<< HEAD",
    "Ours x <= y <kbd>K</kbd>",
    "=======",
    "Theirs { open <u>u</u>",
    ">>>>>>> branch",
    "",
    "after I <3 it",
    "",
  ].join("\n");
  const editor = editorFor(conflicted);
  expect(marked(editor.children, "underline")).toEqual(["under"]);
  const texts = blockTexts(editor.children);
  expect(texts[0]).toBe("before a<b under");
  expect(texts.at(-1)).toBe("after I <3 it");
  const conflict = editor.children.find(
    (node) => (node as TElement).type === "conflict",
  ) as unknown as ConflictElement;
  // Same insertion as `ConflictElementComponent.replaceWithMarkdown`.
  const ours = deserializeEditorMarkdownInsertion(editor, conflict.ours);
  expect(blockTexts(ours)).toEqual(["Ours x <= y K"]);
  expect(marked(ours, "kbd")).toEqual(["K"]);
  const theirs = deserializeEditorMarkdownInsertion(editor, conflict.theirs);
  expect(blockTexts(theirs)).toEqual(["Theirs { open u"]);
  expect(marked(theirs, "underline")).toEqual(["u"]);
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
  const texts = blockTexts(editor.children).join("\n");
  expect(texts).toContain("x a<b y under");
  expect(texts).toContain("open { only K");
  expect(marked(editor.children, "kbd")).toEqual(["K"]);
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

test("R5 code blocks for conflicts are found with MDX next to R2 text", () => {
  const editor = createEditor();
  // With MDX the fence inside <callout> is code; without it, part of an HTML
  // block.
  const source = "<callout>\n```\nx\n```\n</callout>\n\nx a<b y { open\n";
  const start = source.indexOf("```");
  const end = source.lastIndexOf("```") + 3;
  expect(fencedCodeRanges(editor, source)).toEqual([{ start, end }]);
  expect(elements(editorFor(source).children, "code_block")).toHaveLength(1);
});

// R6: 2 000 lines, 200 of them with `<` MDX rejects.
const r6Places = ["x a<b y", "if x <= y then", "I <3 it", "text <div> more"];
const r6Plain = ["x ab y", "if x = y then", "I 3 it", "text div more"];

function r6Document(places: string[]): string {
  const lines: string[] = [];
  for (let block = 0; block < 1000; block += 1) {
    const place =
      block % 5 === 0 ? ` ${places[(block / 5) % places.length]}` : "";
    switch (block % 4) {
      case 0:
        lines.push(`Paragraph ${block} with <u>under</u>${place}`);
        break;
      case 1:
        lines.push(`- item ${block} <kbd>K</kbd>${place}`);
        break;
      case 2:
        lines.push(`## Heading ${block}${place}`);
        break;
      default:
        lines.push(`Text ${block} with [link](Plan.md) and **bold**${place}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function readTime(editor: Editor, source: string): number {
  const start = performance.now();
  deserializeWithConflicts(editor, source, DEFAULT_CONFLICT_MARKER_SIZE);
  return performance.now() - start;
}

test("R6 reading 200 lines of 2 000 with R2 places takes at most twice as long", () => {
  const withPlaces = r6Document(r6Places);
  const plain = r6Document(r6Plain);
  expect(withPlaces.split("\n")).toHaveLength(2000);
  expect(
    withPlaces
      .split("\n")
      .filter((line) => line.includes("<") && /<[=3bd]/.test(line)),
  ).toHaveLength(200);
  const editor = createEditor();
  const read = deserializeWithConflicts(
    editor,
    withPlaces,
    DEFAULT_CONFLICT_MARKER_SIZE,
  );
  expect(marked(read, "underline")).toHaveLength(250);
  expect(blockTexts(read).filter((text) => text.includes("<"))).toHaveLength(
    200,
  );
  // Warm up both, then alternate the runs; load from other processes only
  // adds time, so the fastest run of each is compared.
  readTime(editor, plain);
  readTime(editor, withPlaces);
  const plainTimes: number[] = [];
  const placeTimes: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    plainTimes.push(readTime(editor, plain));
    placeTimes.push(readTime(editor, withPlaces));
  }
  const plainTime = Math.min(...plainTimes);
  const placeTime = Math.min(...placeTimes);
  const ratio = placeTime / plainTime;
  console.log(
    `R6 plain ${plainTime.toFixed(1)} ms, with places ${placeTime.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`,
  );
  expect(ratio).toBeLessThanOrEqual(2);
}, 60_000);
