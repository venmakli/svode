import { expect, test } from "bun:test";
import { LinkPlugin, submitFloatingLink } from "@platejs/link/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type Descendant, type TElement, type TText } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import {
  deserializeConflictBranch,
  deserializeWithConflicts,
} from "../src/features/editor/conflict/parse-conflicts";
import { applyLinkUrl } from "../src/features/editor/lib/page-link-editor-actions";
import { MARKDOWN_LINK_DEFINITION_KEY } from "../src/features/editor/model/markdown-comments";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;
type Target = TElement & { url: string; title?: string; alt?: string };

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

function elementsOf(nodes: Descendant[], types: string[]): Target[] {
  const found: Target[] = [];
  const visit = (node: Descendant) => {
    const element = node as Target;
    if (types.includes(element.type)) found.push(element);
    for (const child of (element.children ?? []) as Descendant[]) visit(child);
  };
  nodes.forEach(visit);
  return found;
}

const links = (nodes: Descendant[]) => elementsOf(nodes, ["a"]);
const images = (nodes: Descendant[]) =>
  elementsOf(nodes, ["img", "inline_img"]);

function pathOfText(editor: Editor, text: string) {
  for (const [node, path] of NodeApi.texts(editor)) {
    const offset = (node as TText).text.indexOf(text);
    if (offset !== -1) return { path, offset };
  }
  throw new Error(`text not found: ${text}`);
}

function expectRoundTrip(source: string) {
  const editor = editorFor(source);
  const saved = save(editor);
  expect(saved).toBe(source);
  expect(save(editorFor(saved))).toBe(source);
  return editor;
}

// DF-211 acceptance 1: every source is in house style, so load → save gives
// it back byte for byte, and a second round trip changes nothing.
const corpus: Record<string, string> = {
  forms:
    'See [docs][ref], [Ref][] and [x].\n\n[ref]: https://example.com\n[x]: https://x.dev "T"\n',
  formattedText:
    "Read [*the* **docs**][ref] now.\n\n[ref]: https://example.com\n",
  imageInParagraph: 'Before ![alt][img] after.\n\n[img]: ./a.png "Pic"\n',
  imageBlock: "Text\n\n![alt][img]\n\n[img]: ./a.png\n",
  imageWithoutAlt:
    "Text\n\n![][img] and ![img] and ![Img][]\n\n[img]: ./a.png\n",
  pageLink: "Read [Plan][p] and [plan].\n\n[p]: ./plan.md\n[plan]: plan.md\n",
  heading: "# Head [a]\n\n## Other [Text][a]\n\n[a]: https://a.dev\n",
  quote: "> Quote [a] and ![i][img]\n\n[a]: https://a.dev\n[img]: ./i.png\n",
  bulletList: "- item [a]\n  - nested [b][a]\n- next\n\n[a]: https://a.dev\n",
  orderedList: "1. one [a]\n2. two [A][]\n\n[a]: https://a.dev\n",
  tableCell:
    "| Head | Link           |\n| ---- | -------------- |\n| one  | [a]            |\n| two  | ![i][img] text |\n\n[a]: https://a.dev\n[img]: ./i.png\n",
  unusedDefinition:
    "See [a].\n\n[a]: https://a.dev\n[unused]: https://unused.dev\n",
  repeatedLabel:
    "See [a].\n\n[a]: https://first.dev\n[a]: https://second.dev\n",
  definitionInList: "- See [d]\n\n  [d]: https://d.dev\n- two\n",
  definitionInQuote: "> See [q]\n>\n> [q]: https://q.dev\n",
  titleForms:
    "[q] [s] [p]\n\n[q]: https://q.dev \"double\"\n[s]: https://s.dev 'single'\n[p]: https://p.dev (paren)\n",
  angleDestination:
    '[a] and [Draft][d]\n\n[a]: <https://a.dev/with space> "T"\n[d]: <Roadmap Draft.md>\n',
  commentDefinition: "See [a].\n\n[//]: # (note)\n\n[a]: https://a.dev\n",
  footnote: "See [a] and note[^1].\n\n[a]: https://a.dev\n\n[^1]: The note.\n",
  escapedLabel: "See [x][a\\]b] and [a\\]b].\n\n[a\\]b]: https://a.dev\n",
  listLeadDefinition: "- [l1]: https://l1.dev\n- two [l1]\n",
  multilineDefinition:
    'See [m].\n\n[m]:\n  https://m.dev\n  "title\n  on two lines"\n',
  labelCase: "See [Docs][REF] and [ref].\n\n[Ref]: https://example.com\n",
};

for (const [name, source] of Object.entries(corpus)) {
  test(`reference corpus round trip: ${name}`, () => {
    expectRoundTrip(source);
  });
}

test("references show as links and images with the text and target of the definition", () => {
  const editor = expectRoundTrip(corpus.forms);
  expect(
    links(editor.children).map(({ url, title }) => ({ url, title })),
  ).toEqual([
    { url: "https://example.com", title: undefined },
    { url: "https://example.com", title: undefined },
    { url: "https://x.dev", title: "T" },
  ]);
  expect(links(editor.children).map((link) => NodeApi.string(link))).toEqual([
    "docs",
    "Ref",
    "x",
  ]);

  const pictures = editorFor(
    'Before ![alt][img] after.\n\n![Block][img]\n\n[img]: ./a.png "Pic"\n',
  );
  expect(
    images(pictures.children).map(({ type, url, title, alt }) => ({
      type,
      url,
      title,
      alt,
    })),
  ).toEqual([
    { type: "inline_img", url: "./a.png", title: "Pic", alt: "alt" },
    { type: "img", url: "./a.png", title: "Pic", alt: undefined },
  ]);
  expect(images(pictures.children)[1]).toMatchObject({
    caption: [{ text: "Block" }],
  });
});

test("a reference to a Page is a Page link element", () => {
  const editor = expectRoundTrip(corpus.pageLink);
  expect(links(editor.children).map(({ url }) => url)).toEqual([
    "./plan.md",
    "plan.md",
  ]);
});

test("the first definition of a label is the target", () => {
  const editor = expectRoundTrip(corpus.repeatedLabel);
  expect(links(editor.children)[0]?.url).toBe("https://first.dev");
});

test("a reference without a definition stays text", () => {
  const editor = editorFor("See [nope][missing] and [x].\n");
  expect(links(editor.children)).toEqual([]);
  expect(NodeApi.string(editor.children[0]!)).toBe(
    "See [nope][missing] and [x].",
  );
  expect(save(editor)).toBe("See \\[nope]\\[missing] and \\[x].\n");
});

test("a reference resolves by a definition on the other side of a conflict block", () => {
  const editor = editorFor(
    'Before [a] and ![i][img]\n\n<<<<<<< HEAD\nOurs\n=======\nTheirs\n>>>>>>> branch\n\nAfter [b]\n\n[a]: https://a.dev\n[img]: ./i.png\n\n<<<<<<< HEAD\nOurs 2\n=======\nTheirs 2\n>>>>>>> branch\n\n[b]: https://b.dev "B"\n',
  );
  expect(
    links(editor.children).map(({ url, title }) => ({ url, title })),
  ).toEqual([
    { url: "https://a.dev", title: undefined },
    { url: "https://b.dev", title: "B" },
  ]);
  expect(images(editor.children).map(({ url }) => url)).toEqual(["./i.png"]);
  expect(
    elementsOf(editor.children, [MARKDOWN_LINK_DEFINITION_KEY]).length,
  ).toBe(3);
});

test("a segment that ends inside a block keeps its text and resolves by its own definitions", () => {
  const editor = editorFor(
    "See [own].\n\n[own]: https://own.dev\n\n```\ncode [a]\n<<<<<<< HEAD\nOurs\n=======\nTheirs\n>>>>>>> branch\n```\n\n[a]: https://a.dev\n",
  );
  expect(links(editor.children).map(({ url }) => url)).toEqual([
    "https://own.dev",
  ]);
  const code = editor.children.find(
    (node) => (node as TElement).type === "code_block",
  );
  expect(NodeApi.string(code!)).toBe("code [a]");
});

// R3: the reference form is kept while the definition matches the target.
const r3Source =
  'Intro [docs][ref] and [x] end\n\n[ref]: https://example.com\n[x]: https://x.dev "T"\n';

test("R3 editing the text of a reference keeps its form", () => {
  const editor = editorFor(r3Source);
  editor.tf.insertText(" edited", {
    at: { ...pathOfText(editor, "docs"), offset: 4 },
  });
  editor.tf.insertText("y", {
    at: { ...pathOfText(editor, "x"), offset: 1 },
  });
  expect(save(editor)).toBe(
    'Intro [docs edited][ref] and [xy][x] end\n\n[ref]: https://example.com\n[x]: https://x.dev "T"\n',
  );
});

test("R3 a new address from the link toolbar writes the link inline", () => {
  const editor = editorFor(r3Source);
  editor.tf.select({ ...pathOfText(editor, "x"), offset: 1 });
  editor.setOption(LinkPlugin, "url", "https://other.dev");
  editor.setOption(LinkPlugin, "text", "x");
  submitFloatingLink(editor);
  expect(save(editor)).toBe(
    'Intro [docs][ref] and [x](https://other.dev "T") end\n\n[ref]: https://example.com\n[x]: https://x.dev "T"\n',
  );
});

test("R3 repairing a broken Page link writes it inline", () => {
  const source = "See [Plan][p].\n\n[p]: old.md\n";
  const editor = editorFor(source);
  editor.tf.select({ ...pathOfText(editor, "Plan"), offset: 1 });
  applyLinkUrl(editor, "new.md");
  expect(save(editor)).toBe("See [Plan](new.md).\n\n[p]: old.md\n");
});

test("R3 deleting the definition marker writes its references inline, Undo restores the form", () => {
  const editor = editorFor(r3Source);
  const index = editor.children.findIndex((node) =>
    (node as TElement & { raw?: string }).raw?.startsWith("[x]"),
  );
  editor.tf.removeNodes({ at: [index] });
  expect(save(editor)).toBe(
    'Intro [docs][ref] and [x](https://x.dev "T") end\n\n[ref]: https://example.com\n',
  );
  editor.undo();
  expect(save(editor)).toBe(r3Source);
});

test("R3 a changed image address writes the image inline", () => {
  const editor = editorFor(
    "Before ![a][img] after.\n\n![b][img]\n\n[img]: ./a.png\n",
  );
  for (const [node, path] of NodeApi.elements(editor)) {
    if (node.type === "inline_img") {
      editor.tf.setNodes({ url: "./b.png" }, { at: path });
    }
  }
  expect(save(editor)).toBe(
    "Before ![a](./b.png) after.\n\n![b][img]\n\n[img]: ./a.png\n",
  );
});

test("R3 a reference moved to a document without its definition is written inline", () => {
  const source = editorFor(r3Source);
  const fragment = source.api.fragment({
    anchor: pathOfText(source, "Intro"),
    focus: { ...pathOfText(source, " end"), offset: 4 },
  });
  const target = editorFor("Target\n");
  target.tf.select({ ...pathOfText(target, "Target"), offset: 6 });
  target.tf.insertFragment(fragment);
  expect(save(target)).toBe(
    'TargetIntro [docs](https://example.com) and [x](https://x.dev "T") end\n',
  );

  // Within the same document the copy stays a reference.
  source.tf.select({ ...pathOfText(source, " end"), offset: 4 });
  source.tf.insertFragment(fragment);
  expect(save(source)).toBe(
    'Intro [docs][ref] and [x] endIntro [docs][ref] and [x] end\n\n[ref]: https://example.com\n[x]: https://x.dev "T"\n',
  );
});

// R4: every Markdown → editor value path resolves references the same way.
const pathSource =
  "Intro [docs][ref] and ![i][img] here.\n\n[ref]: https://example.com\n[img]: ./i.png\n";

test("R4 Page load and watcher reload resolve references", () => {
  const editor = editorFor("Old text\n");
  loadProgrammaticEditorValue(
    editor,
    deserializeWithConflicts(editor, pathSource, DEFAULT_CONFLICT_MARKER_SIZE),
  );
  expect(links(editor.children)[0]?.url).toBe("https://example.com");
  expect(save(editor)).toBe(pathSource);
});

test("R4 Accept of a conflict branch resolves by the branch and the document definitions", () => {
  const conflicted =
    "# Title [doc]\n\n<<<<<<< HEAD\nOurs [doc] and [o]\n\n[o]: https://ours.dev\n=======\nTheirs [doc]\n>>>>>>> branch\n\n[doc]: https://doc.dev\n";
  for (const choice of ["ours", "theirs", "edit"] as const) {
    const editor = editorFor(conflicted);
    const index = editor.children.findIndex(
      (node) => (node as TElement).type === "conflict",
    );
    const conflict = editor.children[index] as TElement & {
      ours: string;
      theirs: string;
    };
    const markdown =
      choice === "ours"
        ? conflict.ours
        : choice === "theirs"
          ? conflict.theirs
          : `${conflict.ours}\n\n---\n\n${conflict.theirs}`;
    // Same insertion as `ConflictElementComponent.replaceWithMarkdown`.
    const fragment = deserializeConflictBranch(editor, markdown.trim() + "\n");
    editor.tf.removeNodes({ at: [index] });
    editor.tf.insertNodes(fragment as never, { at: [index] });
    const saved = save(editor);
    expect(saved.startsWith("# Title [doc]\n\n")).toBe(true);
    expect(saved.endsWith("\n[doc]: https://doc.dev\n")).toBe(true);
    if (choice !== "theirs") {
      expect(saved).toContain("Ours [doc] and [o]\n\n[o]: https://ours.dev\n");
    }
    if (choice !== "ours") expect(saved).toContain("Theirs [doc]\n");
  }
});

test("R4 Routine field value keeps references when neighbouring text changes", () => {
  // Same calls as `ControlledMarkdownEditor`: value init and onChange.
  const editor = createPlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, pathSource) as never,
  });
  expect(links(editor.children)[0]?.url).toBe("https://example.com");
  editor.tf.insertText("edited ", { at: pathOfText(editor, "Intro") });
  const changed = editor
    .getApi(MarkdownPlugin)
    .markdown.serialize({ value: editor.children });
  expect(changed).toBe(pathSource.replace("Intro", "edited Intro"));
});

test("R4 toolbar Markdown import resolves references by the imported definitions", () => {
  const editor = editorFor("Existing [doc]\n\n[doc]: https://doc.dev\n");
  const fragment = deserializeImportedMarkdown(pathSource, (text) =>
    deserializeEditorMarkdownInsertion(editor, text),
  );
  expect(links(fragment)[0]?.url).toBe("https://example.com");
  editor.tf.insertNodes(fragment as never, { at: [1] });
  expect(save(editor)).toBe(
    `Existing [doc]\n\n${pathSource}[doc]: https://doc.dev\n`,
  );
});

test("R4 pasted text/plain resolves by its own definitions only", () => {
  const editor = editorFor("Existing\n\nTarget\n\n[doc]: https://doc.dev\n");
  editor.tf.select({ ...pathOfText(editor, "Target"), offset: 6 });
  const text = "See [doc] and [own][p].\n\n[p]: https://pasted.dev\n";
  const data: Record<string, string> = { "text/plain": text };
  editor.tf.insertData({
    files: [] as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer);
  expect(links(editor.children).map(({ url }) => url)).toEqual([
    "https://pasted.dev",
  ]);
  expect(save(editor)).toContain("See \\[doc] and [own][p].");
  expect(save(editor)).toContain("[p]: https://pasted.dev\n");
});

// R5: edits next to a reference and its definition.
test("R5 typing and formatting next to references keep them", () => {
  const editor = editorFor(r3Source);
  editor.tf.insertText("X", { at: pathOfText(editor, "Intro") });
  editor.tf.select({
    anchor: pathOfText(editor, " end"),
    focus: { ...pathOfText(editor, " end"), offset: 4 },
  });
  editor.tf.addMark("bold", true);
  expect(save(editor)).toBe(
    'XIntro [docs][ref] and [x] **end**\n\n[ref]: https://example.com\n[x]: https://x.dev "T"\n',
  );
});
