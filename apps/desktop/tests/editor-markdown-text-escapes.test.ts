import { describe, expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Descendant } from "platejs";
import { createPlateEditor } from "platejs/react";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import {
  deserializeConflictBranches,
  deserializeWithConflicts,
} from "../src/features/editor/conflict/parse-conflicts";
import {
  MARKDOWN_LINK_DEFINITION_KEY,
  serializeMarkdownWithComments,
} from "../src/features/editor/model/markdown-comments";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

function editorWith(value: Descendant[]): Editor {
  const editor = createPlateEditor({ plugins: EditorKit });
  loadProgrammaticEditorValue(editor, value);
  return editor;
}

// The Page path: load → save.
function load(source: string): Editor {
  const editor = createPlateEditor({ plugins: EditorKit });
  return editorWith(
    deserializeWithConflicts(editor, source, DEFAULT_CONFLICT_MARKER_SIZE),
  );
}

function save(editor: Editor): string {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}

type Leaf = { text: string; [mark: string]: unknown };

// Paragraphs and their text, with adjacent leaves of the same marks merged.
function meaning(nodes: Descendant[]): string {
  const visit = (node: Descendant): unknown => {
    const element = node as { type?: string; children?: Descendant[] };
    if (!element.children) return node;
    const children: unknown[] = [];
    for (const child of element.children) {
      const leaf = child as Leaf;
      if (typeof leaf.text !== "string") {
        children.push(visit(child));
        continue;
      }
      const marks = Object.keys(leaf)
        .filter((key) => key !== "text")
        .sort()
        .map((key) => `${key}=${JSON.stringify(leaf[key])}`)
        .join(",");
      const last = children.at(-1) as { marks?: string; text: string };
      if (last && last.marks === marks) last.text += leaf.text;
      else if (leaf.text !== "") children.push({ marks, text: leaf.text });
    }
    const {
      children: _children,
      id: _id,
      ...rest
    } = element as Record<string, unknown>;
    return { ...rest, children };
  };
  return JSON.stringify(nodes.map(visit));
}

function expectSaved(source: string, expected: string) {
  const editor = load(source);
  const saved = save(editor);
  expect(saved).toBe(expected);
  const reloaded = load(saved);
  expect(meaning(reloaded.children)).toBe(meaning(editor.children));
  expect(save(reloaded)).toBe(saved);
}

// DF-265 R1: characters that read as text without `\` are written bare, in
// every container and inside emphasis and links.
const bare: Record<string, string> = {
  paragraph:
    "Текст snake_case, a_b_c, a _ b, 2 * 3, *x and y, a ` b, AT&T, a@b and ~approx.\n",
  heading: "## snake_case 2 * 3 AT&T\n",
  bulletList: "- snake_case and 2 * 3\n  - AT&T and a ` b\n",
  orderedList: "1. a_b and 2 * 3\n",
  blockquote: "> snake_case and a ` b\n",
  table: "| a_b  | 2 * 3 |\n| ---- | ----- |\n| AT&T | * x   |\n",
  insideMarks: "*snake_case and 2 * 3* and **AT&T** and ~~a_b~~\n",
  insideLink: "[snake_case & a ` b](https://example.com)\n",
  softBreak: "first a_b\nsecond 2 * 3\n",
};

// DF-265 R2: characters that would read as markup keep one `\` where it is
// needed, the opening one of a pair.
const needed: Record<string, string> = {
  pairs: "\\*a* and \\_b_ and \\`c` and \\~d~\n",
  characterReferences: "\\&copy; and \\&#35; and AT&T\n",
  lineStarts:
    "\\* not a list\n\n\\***\n\n\\``` not a fence\n\n\\~~~ x\n\n\\___\n",
  headingAndCell: "# \\*not em* heading\n\n| \\*a* | b |\n| ---- | - |\n",
  acrossSoftBreak: "line one *x\n\\* y and z*\n",
  mdxCharacters: "obj \\{a: 1} and 1 \\< 2\n",
};

describe("DF-265A minimal escaping of text characters", () => {
  for (const [name, source] of Object.entries(bare)) {
    test(`writes characters that read as text bare: ${name}`, () => {
      expectSaved(source, source);
    });
  }

  for (const [name, source] of Object.entries(needed)) {
    test(`keeps the escapes the reading needs: ${name}`, () => {
      expectSaved(source, source);
    });
  }

  test("writes one escape of a pair the source escaped twice", () => {
    expectSaved("\\_escaped\\_ and \\`code\\`\n", "\\_escaped_ and \\`code`\n");
  });

  test("drops the escapes earlier saves wrote (R3)", () => {
    expectSaved(
      "snake\\_case, 2 \\* 3, AT\\&T, a\\@b, a \\` b and \\~x\n",
      "snake_case, 2 * 3, AT&T, a@b, a ` b and ~x\n",
    );
  });

  test("keeps the DF-264 evidence line byte for byte", () => {
    const source =
      "Ссылка https://example.com/a_b?x=1&y=*2*\nследующая строка\n";
    expectSaved(source, source);
  });

  test("writes the Routine field and export paths the same way (R5)", () => {
    const source = "snake_case and 2 * 3, \\*a* and AT&T\n";
    const editor = createPlateEditor({ plugins: EditorKit });
    const value = deserializeEditorMarkdownInsertion(editor, source);
    loadProgrammaticEditorValue(editor, value);
    expect(editor.getApi(MarkdownPlugin).markdown.serialize({ value })).toBe(
      source,
    );
    expect(save(editor)).toBe(source);
  });
});

// DF-265 R1 for brackets: `[`, `]` and `!` that read as text without `\` are
// written bare, in every container.
const bareBrackets: Record<string, string> = {
  evidence: "Текст со ссылкой [[Цели компании]] и snake_case.\n",
  paragraph:
    "[[Page|alias]], array[0], [note], ![not], [nope][missing], x] y, f(x) and (a)[b]!\n",
  heading: "## [[Page|alias]] and array[0]\n",
  bulletList: "- [[Цели]] and [note]\n  - ![not] and [nope][missing]\n",
  orderedList: "1. array[0] and [x] y\n",
  blockquote: "> [ ] not a task and [[Цели]]\n",
  table: "| [[a]] | array[0] |\n| ----- | -------- |\n| [x]   | ![not]   |\n",
  insideMarks: "*[[Цели]] and [note]* and **array[0]**\n",
  insideLink: "[a [b] c and [[d]]](https://example.com)\n",
  taskItem: "- [ ] task with [ ] and [note]\n",
  undefinedFootnote: "See [^1] here\n",
  linkLiteral: "Hello! World [x] (y)\n",
};

// DF-265 R2 for brackets: brackets that would read as a link, image,
// reference, footnote call, definition or task marker keep one `\`.
const neededBrackets: Record<string, string> = {
  inlineLink: "\\[x](y) and !\\[i](y) and text !\\[link](https://x.dev)\n",
  definedLabel:
    "\\[Plan] and [Plan], \\[Plan][] and \\[a][Plan], array\\[plan]\n\n[Plan]: https://plan.example\n",
  headingAndCell:
    "# \\[Plan] heading\n\n| \\[Plan] | [[x]] |\n| ------- | ----- |\n\n[Plan]: https://plan.example\n",
  footnote: "See [^1] and \\[^1]\n\n[^1]: Note.\n",
  taskMarker: "- \\[ ] not a task\n- \\[x] not done\n",
  orderedTaskMarker: "1. \\[ ] not a task\n",
  definition: "\\[a]: b\n\n- \\[c]: d\n",
  linkText: "[a \\] b](https://x.dev) and [a \\[b c](https://x.dev)\n",
};

describe("DF-265B minimal escaping of brackets", () => {
  for (const [name, source] of Object.entries(bareBrackets)) {
    test(`writes brackets that read as text bare: ${name}`, () => {
      expectSaved(source, source);
    });
  }

  for (const [name, source] of Object.entries(neededBrackets)) {
    test(`keeps the bracket escapes the reading needs: ${name}`, () => {
      expectSaved(source, source);
    });
  }

  test("drops the bracket escapes earlier saves wrote (R3)", () => {
    expectSaved(
      "\\[\\[x]], array\\[0], \\[nope]\\[missing], \\!\\[x](y) and \\[x]\\(y)\n",
      "[[x]], array[0], [nope][missing], !\\[x](y) and \\[x](y)\n",
    );
  });

  test("escapes a bracket by a definition on the other side of a conflict block", () => {
    const editor = load(
      "\\[Plan] before and [[x]]\n\n<<<<<<< HEAD\nOurs \\[Plan] and [o]\n=======\nTheirs\n>>>>>>> branch\n\n[Plan]: https://plan.example\n",
    );
    const index = editor.children.findIndex(
      (node) => (node as { type?: string }).type === "conflict",
    );
    const conflict = editor.children[index] as unknown as { ours: string };
    // Same insertion as Accept mine of `SidesConflict`.
    const fragment = deserializeConflictBranches(editor, [conflict.ours]);
    editor.tf.removeNodes({ at: [index] });
    editor.tf.insertNodes(fragment as never, { at: [index] });
    expect(save(editor)).toBe(
      "\\[Plan] before and [[x]]\n\nOurs \\[Plan] and [o]\n\n[Plan]: https://plan.example\n",
    );
  });

  test("escapes inserted text by the definitions of the document it lands in", () => {
    const editor = load("Existing\n\n[doc]: https://doc.dev\n");
    const fragment = deserializeEditorMarkdownInsertion(
      editor,
      "See [doc], array[0] and [own].\n\n[own]: https://own.dev\n",
    );
    editor.tf.insertNodes(fragment as never, { at: [1] });
    expect(save(editor)).toBe(
      "Existing\n\nSee \\[doc], array[0] and [own].\n\n[own]: https://own.dev\n[doc]: https://doc.dev\n",
    );
  });
});

// R4: save → read gives the value back for generated text of the R1
// characters with marks, and a second save writes the same text.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const TOKENS = [
  "a",
  "b",
  "x",
  "1",
  "é",
  " ",
  " ",
  "_",
  "*",
  "`",
  "&",
  "~",
  "@",
  ".",
  ";",
  "amp;",
  "#35;",
  "[",
  "]",
  "!",
  "(",
  ")",
  ":",
  "[a]",
  "[^1]",
];
const MARKS = ["bold", "italic", "strikethrough", "code"];
// `@name` after a space or at the start of a text reads as a mention: out of
// DF-265.
const MENTION_RE = /(^|\s)@[\w-]/;

function hasMention(value: Descendant[]): boolean {
  const leaves = (value[0] as unknown as { children: Leaf[] }).children;
  return leaves.some((leaf, index) => {
    const before = leaves[index - 1];
    return MENTION_RE.test(
      before && !Object.keys(before).some((key) => key !== "text")
        ? before.text + leaf.text
        : leaf.text,
    );
  });
}

function generatedValue(next: () => number, wrapMarks: boolean): Descendant[] {
  const leaves: Leaf[] = [];
  const count = 1 + Math.floor(next() * 4);
  for (let index = 0; index < count; index += 1) {
    let text = "";
    const length = 1 + Math.floor(next() * 8);
    for (let k = 0; k < length; k += 1) {
      text += TOKENS[Math.floor(next() * TOKENS.length)];
    }
    const leaf: Leaf = { text };
    if (next() < 0.35) {
      leaf[MARKS[Math.floor(next() * MARKS.length)]] = true;
      if (wrapMarks) leaf.text = `a${text}b`;
    }
    leaves.push(leaf);
  }
  return [{ type: "p", children: leaves }] as unknown as Descendant[];
}

// Definitions of the labels `a` and `1`, which make brackets references and
// footnote calls.
const DEFINITIONS = [
  {
    type: MARKDOWN_LINK_DEFINITION_KEY,
    raw: "[a]: https://a.dev",
    children: [{ text: "" }],
  },
  {
    identifier: "1",
    type: "footnoteDefinition",
    children: [{ type: "p", children: [{ text: "Note." }] }],
  },
] as unknown as Descendant[];

function plainText(value: Descendant[]): string {
  return (value[0] as unknown as { children: Leaf[] }).children
    .map((leaf) => leaf.text)
    .join("");
}

describe("DF-265 round trip (R4)", () => {
  // Marked text that starts and ends with a letter: remark writes whitespace
  // and flanking at mark edges in ways that do not read back, with any
  // escaping.
  test("save → read keeps the value and a second save is stable", () => {
    const next = random(7);
    let checked = 0;
    for (let index = 0; index < 400; index += 1) {
      const value = generatedValue(next, true);
      const text = plainText(value);
      if (hasMention(value) || text !== text.trim() || text.includes("  ")) {
        continue;
      }
      checked += 1;
      const editor = editorWith(value);
      const saved = save(editor);
      const reloaded = load(saved);
      expect({ saved, value: meaning(reloaded.children) }).toEqual({
        saved,
        value: meaning(editor.children),
      });
      expect(save(reloaded)).toBe(saved);
    }
    expect(checked).toBeGreaterThan(200);
  }, 120_000);

  test("keeps the value of brackets by the definitions of the document", () => {
    const next = random(13);
    let checked = 0;
    for (let index = 0; index < 400; index += 1) {
      const value = [...generatedValue(next, true), ...DEFINITIONS];
      const text = plainText(value);
      if (hasMention(value) || text !== text.trim() || text.includes("  ")) {
        continue;
      }
      checked += 1;
      const editor = editorWith(value);
      const saved = save(editor);
      const reloaded = load(saved);
      expect({ saved, value: meaning(reloaded.children) }).toEqual({
        saved,
        value: meaning(editor.children),
      });
      expect(save(reloaded)).toBe(saved);
    }
    expect(checked).toBeGreaterThan(200);
  }, 120_000);

  test("reads back every value remark's escaping reads back", () => {
    const next = random(11);
    for (let index = 0; index < 400; index += 1) {
      const value = generatedValue(next, false);
      if (hasMention(value)) continue;
      const editor = editorWith(value);
      const expected = meaning(editor.children);
      const conservative = serializeMarkdownWithComments(editor, {});
      if (meaning(load(conservative).children) !== expected) continue;
      const saved = save(editor);
      expect({ saved, value: meaning(load(saved).children) }).toEqual({
        saved,
        value: expected,
      });
    }
  }, 120_000);
});
