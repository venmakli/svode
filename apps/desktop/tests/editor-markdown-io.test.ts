import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Descendant } from "platejs";
import { createPlateEditor } from "platejs/react";
import { BasicBlocksKit } from "../src/components/editor/plugins/basic-blocks-kit";
import { CodeBlockKit } from "../src/components/editor/plugins/code-block-kit";
import { LinkKit } from "../src/components/editor/plugins/link-kit";
import { ListKit } from "../src/components/editor/plugins/list-kit";
import { MarkdownKit } from "../src/components/editor/plugins/markdown-kit";
import { MediaKit } from "../src/components/editor/plugins/media-kit";
import { TableKit } from "../src/components/editor/plugins/table-kit";
import { deserializeImportedMarkdown } from "../src/components/ui/import-toolbar-button";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import {
  deserializeEditorMarkdownInsertion,
  normalizeMarkdownForPlate,
} from "../src/features/editor/model/markdown-io";

type PlateNode = Descendant & {
  children?: PlateNode[];
  text?: string;
  type?: string;
};

const fixtures = {
  gfmTableBareBr: [
    "| Area | Status |",
    "| --- | --- |",
    "| Parser | first line<br>second line |",
    "| Next row | still table |",
  ].join("\n"),
  gfmTableSelfClosingBr: [
    "| Area | Status |",
    "| --- | --- |",
    "| Parser | first line<br />second line |",
  ].join("\n"),
  taskListNested: [
    "- [x] Ship parser boundary",
    "- [ ] Follow-up",
    "  - nested bullet",
  ].join("\n"),
  codeBlockWithPipes: ["```ts", 'const row = "a | b | c";', "```"].join("\n"),
  inlineHtml: "GitHub-style inline <kbd>Cmd</kbd> hint with normal text.",
  linksAndImages: "See [docs](./docs.md) and ![diagram](./assets/diagram.png).",
  frontmatterAndBody: ["---", "title: Fixture", "---", "# Body"].join("\n"),
  unsupportedMdxAdjacent:
    'Current fallback keeps this crash-free: <Alert tone="info">Heads up</Alert>.',
  mergeConflict: [
    "<<<<<<< HEAD",
    "| A | B |",
    "| --- | --- |",
    "| ours | one<br>two |",
    "=======",
    "| A | B |",
    "| --- | --- |",
    "| theirs | one<br>two |",
    ">>>>>>> branch",
  ].join("\n"),
};

function createMarkdownEditor() {
  return createPlateEditor({
    plugins: [
      ...BasicBlocksKit,
      ...CodeBlockKit,
      ...TableKit,
      ...ListKit,
      ...LinkKit,
      ...MediaKit,
      ...MarkdownKit,
    ],
  });
}

function isTextNode(node: PlateNode): boolean {
  return typeof node.text === "string" && !Array.isArray(node.children);
}

function nodeChildren(node: PlateNode): PlateNode[] | null {
  return Array.isArray(node.children) ? node.children : null;
}

function validateStructure(nodes: Descendant[]) {
  const errors: string[] = [];
  let invalidTableChildren = 0;

  const visit = (node: PlateNode, path: string) => {
    if (isTextNode(node)) return;

    const children = nodeChildren(node);
    if (!children) {
      errors.push(`${path}: non-text node has no children`);
      return;
    }

    if (node.type === "conflict") {
      if (children.length !== 1 || children[0]?.text !== "") {
        errors.push(`${path}: conflict node must keep one empty text child`);
      }
      return;
    }

    if (node.type === "table") {
      for (const [index, child] of children.entries()) {
        if (isTextNode(child) || child.type !== "tr" || !nodeChildren(child)) {
          invalidTableChildren += 1;
          errors.push(`${path}.${index}: table child is not a row`);
        }
      }
    }

    if (node.type === "tr") {
      for (const [index, child] of children.entries()) {
        if (
          isTextNode(child) ||
          (child.type !== "td" && child.type !== "th") ||
          !nodeChildren(child)
        ) {
          errors.push(`${path}.${index}: table row child is not a cell`);
        }
      }
    }

    for (const [index, child] of children.entries()) {
      visit(child, `${path}.${index}`);
    }
  };

  for (const [index, node] of nodes.entries()) {
    visit(node as PlateNode, String(index));
  }

  return { errors, invalidTableChildren };
}

test("document load markdown boundary keeps GFM tables with bare br structurally valid", () => {
  const editor = createMarkdownEditor();
  const value = deserializeWithConflicts(editor, fixtures.gfmTableBareBr);
  const result = validateStructure(value);

  expect(value.length).toBeGreaterThan(0);
  expect(result.invalidTableChildren).toBe(0);
  expect(result.errors).toEqual([]);
});

test("empty document load returns a paragraph-like block", () => {
  const editor = createMarkdownEditor();
  const value = deserializeWithConflicts(editor, "");

  expect(value).toEqual([{ type: "p", children: [{ text: "" }] }]);
});

test("merge conflict accepted branch uses the same markdown insertion boundary", () => {
  const editor = createMarkdownEditor();
  const acceptedBranch = [
    "| A | B |",
    "| --- | --- |",
    "| ours | one<br>two |",
  ].join("\n");
  const value = deserializeEditorMarkdownInsertion(editor, acceptedBranch);
  const result = validateStructure(value);

  expect(result.invalidTableChildren).toBe(0);
  expect(result.errors).toEqual([]);
});

test("toolbar markdown import decision delegates to the injected editor insertion boundary", () => {
  const editor = createMarkdownEditor();
  let importedText: string | null = null;
  const value = deserializeImportedMarkdown(
    editor,
    fixtures.gfmTableBareBr,
    (text) => {
      importedText = text;
      return deserializeEditorMarkdownInsertion(editor, text);
    },
  );
  const result = validateStructure(value);

  expect(importedText).toBe(fixtures.gfmTableBareBr);
  expect(result.invalidTableChildren).toBe(0);
  expect(result.errors).toEqual([]);
});

test("real-world markdown fixtures remain crash-free under structural validation", () => {
  const editor = createMarkdownEditor();
  const cases = [
    fixtures.taskListNested,
    fixtures.codeBlockWithPipes,
    fixtures.inlineHtml,
    fixtures.linksAndImages,
    fixtures.frontmatterAndBody,
    fixtures.unsupportedMdxAdjacent,
    fixtures.mergeConflict,
  ];

  for (const markdown of cases) {
    const value = deserializeWithConflicts(editor, markdown);
    expect(validateStructure(value).errors).toEqual([]);
  }
});

test("stable markdown serializer style uses hyphen bullets", () => {
  const editor = createMarkdownEditor();
  const value = deserializeWithConflicts(editor, "* item\n* second\n");
  editor.tf.setValue(value as never);

  expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
    "- item\n- second\n",
  );
});

test("read-time normalization is pure and does not rewrite the source file", async () => {
  const editor = createMarkdownEditor();
  const dir = await mkdtemp(join(tmpdir(), "svode-editor-markdown-"));
  const path = join(dir, "fixture.md");
  await writeFile(path, fixtures.gfmTableBareBr, "utf8");

  try {
    const source = await readFile(path, "utf8");
    expect(normalizeMarkdownForPlate(source)).toContain("<br />");

    deserializeWithConflicts(editor, source);

    expect(await readFile(path, "utf8")).toBe(fixtures.gfmTableBareBr);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
