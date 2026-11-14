import { describe, expect, test } from "bun:test";
import { upsertLink } from "@platejs/link";
import { LinkPlugin, submitFloatingLink } from "@platejs/link/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { type Descendant, ElementApi, NodeApi, type TText } from "platejs";
import { createPlateEditor } from "platejs/react";
import { DEFAULT_CONFLICT_MARKER_SIZE } from "../src/features/editor/conflict/conflict-markers";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import { deserializeEditorMarkdownInsertion } from "../src/features/editor/model/markdown-io";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

// The Page path: load → save.
function load(source: string): Editor {
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

/** Every link as `url | text`, in document order. */
function links(nodes: Descendant[]): string[] {
  const found: string[] = [];
  const walk = (children: Descendant[]) => {
    for (const node of children) {
      if (!ElementApi.isElement(node)) continue;
      if (node.type === "a") {
        found.push(`${String(node.url)} | ${NodeApi.string(node)}`);
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** Load, save three times: every save is the first and targets stay. */
function expectStable(source: string): string {
  const editor = load(source);
  const targets = links(editor.children);
  const first = save(editor);
  let current = first;
  for (let round = 0; round < 2; round += 1) {
    const reloaded = load(current);
    expect(links(reloaded.children)).toEqual(targets);
    current = save(reloaded);
    expect(current).toBe(first);
  }
  return first;
}

function pathOfText(editor: Editor, text: string) {
  const entry = [...NodeApi.texts(editor)].find(([node]) =>
    (node as TText).text.includes(text),
  );
  if (!entry) throw new Error(`no text ${text}`);
  return {
    path: entry[1],
    offset: (entry[0] as TText).text.indexOf(text),
  };
}

const evidence = "Ссылка https://example.com/a_b?x=1&y=*2*\nследующая строка\n";

// R1: bare literals keep their text and target; punctuation GFM leaves out of
// the URL stays text right after it.
const literals: Record<string, string> = {
  evidence,
  starInside: "See https://example.com/?q=*x* here\n",
  underscores: "See https://example.com/a_b_c here and https://e.com/a_ x\n",
  trailingDot: "See https://example.com/a. Next https://e.com/b).\n",
  parentheses: "See (https://example.com/a) more\n",
  www: "See www.example.com/a_b here\n",
  wwwStar: "See www.example.com/?q=*x* here\n",
  email: "Mail me@example.com now.\n",
  heading: "## Head www.x.com/a_b and me@x.org\n",
  bulletList: "- item https://e.com/?q=*x*\n- www.x.com and me@x.org\n",
  orderedList: "1. www.x.com/a_b\n",
  blockquote: "> quote www.x.com/a_b and https://e.com/a.\n",
  table:
    "| a         | b        |\n| --------- | -------- |\n| www.x.com | me@x.org |\n",
  beforeSoftBreak: "a https://e.com/?q=*x*\nwww.x.com\nme@x.org\nb\n",
  afterSoftBreak: "a\nhttps://x.com b\n",
};

// R2: autolinks `<…>` keep the brackets and the address as it is.
const autolinks: Record<string, string> = {
  stars: "<https://example.com/a_b?y=*2*>\n",
  plain: "and <https://auto.com>\n",
  ftp: "see <ftp://x.org/f> here\n",
  email: "mail <me@example.com> x\n",
  mailto: "x <mailto:me@x.org> y\n",
  backslashes: "<https://example.com/a_b?y=*2\\\\>\n",
  containers:
    "## <https://auto.com>\n\n- <me@x.org>\n\n> <ftp://x.org/f>\n\n| a                  |\n| ------------------ |\n| <https://auto.com> |\n",
};

describe("DF-264A forms of bare URLs and autolinks", () => {
  for (const [name, source] of Object.entries(literals)) {
    test(`R1 a bare literal keeps its form and target: ${name}`, () => {
      expect(expectStable(source)).toBe(source);
    });
  }

  for (const [name, source] of Object.entries(autolinks)) {
    test(`R2 an autolink keeps its brackets: ${name}`, () => {
      expect(expectStable(source)).toBe(source);
    });
  }

  test("R1 the evidence line links to …&y=*2 from the first save", () => {
    const editor = load(evidence);
    expect(links(editor.children)).toEqual([
      "https://example.com/a_b?x=1&y=*2 | https://example.com/a_b?x=1&y=*2",
    ]);
    expect(save(editor)).toBe(evidence);
  });

  test("R4 a line earlier saves corrupted keeps its target and stops growing", () => {
    for (const source of [
      "Ссылка https://example.com/a_b?x=1&y=*2\\*\nследующая строка\n",
      "Ссылка <https://example.com/a_b?x=1&y=*2\\\\>\\*\n",
    ]) {
      const saved = expectStable(source);
      const slashes = (text: string) => text.split("\\").length - 1;
      expect(slashes(saved)).toBeLessThanOrEqual(slashes(source));
    }
  });

  test("R5 the Routine field and pasted text/plain keep the forms", () => {
    const source = "a www.x.com and <https://auto.com> me@x.org\n";
    const editor = createPlateEditor({
      plugins: EditorKit,
      value: (instance) =>
        deserializeEditorMarkdownInsertion(instance, source) as never,
    });
    editor.tf.insertText("edited ", { at: pathOfText(editor, "a ") });
    expect(
      editor
        .getApi(MarkdownPlugin)
        .markdown.serialize({ value: editor.children }),
    ).toBe(`edited ${source}`);

    const target = load("Target\n");
    target.tf.select({ ...pathOfText(target, "Target"), offset: 6 });
    const data: Record<string, string> = { "text/plain": source };
    target.tf.insertData({
      files: [] as unknown as FileList,
      types: Object.keys(data),
      getData: (type: string) => data[type] ?? "",
    } as unknown as DataTransfer);
    expect(save(target)).toContain("www.x.com and <https://auto.com> me@x.org");
  });

  test("R4 editing an unrelated paragraph leaves the link lines alone", () => {
    const source = `${evidence}\nSee www.x.com, me@x.org and <https://auto.com>.\n\nOther\n`;
    const editor = load(source);
    editor.tf.insertText("Edited ", { at: pathOfText(editor, "Other") });
    expect(save(editor)).toBe(source.replace("Other", "Edited Other"));
  });
});

describe("DF-264A R3 the target wins over the form", () => {
  test("a new address of an autolink writes the link with brackets", () => {
    const editor = load("and <https://auto.com> end\n");
    editor.tf.select(pathOfText(editor, "https://auto.com"));
    editor.setOption(LinkPlugin, "url", "https://other.com");
    editor.setOption(LinkPlugin, "text", "https://auto.com");
    submitFloatingLink(editor);
    const saved = save(editor);
    expect(saved).toBe("and [https://auto.com](https://other.com) end\n");
    expect(links(load(saved).children)).toEqual([
      "https://other.com | https://auto.com",
    ]);
  });

  test("an autolink whose text and address change together is written bare", () => {
    const editor = load("and <https://auto.com> end\n");
    editor.tf.select(pathOfText(editor, "https://auto.com"));
    editor.setOption(LinkPlugin, "url", "https://other.com");
    editor.setOption(LinkPlugin, "text", "https://other.com");
    submitFloatingLink(editor);
    expect(save(editor)).toBe("and https://other.com end\n");
  });

  test("an edited literal text is written as an inline link", () => {
    const editor = load("See www.x.com here\n");
    editor.tf.insertText("my ", { at: pathOfText(editor, "www.x.com") });
    const saved = save(editor);
    expect(saved).toBe("See [my www.x.com](http://www.x.com) here\n");
    expect(links(load(saved).children)).toEqual([
      "http://www.x.com | my www.x.com",
    ]);
  });

  test("a link made in the editor with its address as text is written bare", () => {
    const editor = load("See x end\n");
    editor.tf.select({
      anchor: pathOfText(editor, "x"),
      focus: { ...pathOfText(editor, "x"), offset: 5 },
    });
    upsertLink(editor, {
      url: "https://new.com/a",
      text: "https://new.com/a",
      skipValidation: true,
    });
    expect(save(editor)).toBe("See https://new.com/a end\n");
  });

  test("a link made in the editor right after a word is written in <…>", () => {
    const editor = load("Intro\n");
    editor.tf.select({ ...pathOfText(editor, "Intro"), offset: 5 });
    upsertLink(editor, {
      url: "https://new.com/a",
      text: "https://new.com/a",
      skipValidation: true,
    });
    const saved = save(editor);
    expect(saved).toBe("Intro<https://new.com/a>\n");
    expect(links(load(saved).children)).toEqual([
      "https://new.com/a | https://new.com/a",
    ]);
  });

  for (const [name, after, expected] of [
    ["a letter", "b", "<https://e.com/a>b"],
    ["emphasis-like text", "*b*", "<https://e.com/a>\\*b*"],
    ["a word in bold", "**b**", "<https://e.com/a>**b**"],
  ] as const) {
    test(`a bare URL followed by ${name} keeps its end in <…>`, () => {
      const editor = load("x\n");
      editor.tf.replaceNodes(
        [
          { text: "See " },
          {
            type: "a",
            url: "https://e.com/a",
            children: [{ text: "https://e.com/a" }],
          },
          ...(after === "**b**"
            ? [{ text: "b", bold: true }]
            : [{ text: after }]),
          { text: " end" },
        ] as never,
        { at: [0], children: true },
      );
      const saved = save(editor);
      expect(saved).toBe(`See ${expected} end\n`);
      const reloaded = load(saved);
      expect(links(reloaded.children)).toEqual([
        "https://e.com/a | https://e.com/a",
      ]);
      expect(NodeApi.string(reloaded.children[0])).toBe(
        NodeApi.string(editor.children[0]),
      );
      expect(save(reloaded)).toBe(saved);
    });
  }

  test("a URL whose last character GFM leaves out is written in <…>", () => {
    const editor = load("x\n");
    editor.tf.replaceNodes(
      [
        { text: "See " },
        {
          type: "a",
          url: "https://e.com/a.",
          children: [{ text: "https://e.com/a." }],
        },
        { text: " end" },
      ] as never,
      { at: [0], children: true },
    );
    expect(save(editor)).toBe("See <https://e.com/a.> end\n");
  });

  test("links with brackets, titles and references keep their form (R6)", () => {
    const source =
      '[https://x.com](https://x.com) and [Plan.md](Plan.md) and [d](https://d.com "T") and [r][ref]\n\n[ref]: https://r.com\n';
    expect(expectStable(source)).toBe(
      source.replace("[https://x.com](https://x.com)", "https://x.com"),
    );
  });
});
