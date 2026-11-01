import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { Descendant, Value } from "platejs";
import { act } from "react";
import type { ConflictElement } from "./parse-conflicts";

// Conflict files written by Git 2.55.0 for the same merge under each
// `merge.conflictStyle`; `stashLabels` comes from `git stash pop`.
const fixtures = {
  oneLine: {
    merge: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: local edit",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
      "",
      "Footer",
      "",
    ].join("\n"),
    diff3: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: local edit",
      "||||||| 6abaa59",
      "Status: draft",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
      "",
      "Footer",
      "",
    ].join("\n"),
    zdiff3: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: local edit",
      "||||||| 6abaa59",
      "Status: draft",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
      "",
      "Footer",
      "",
    ].join("\n"),
  },
  emptySide: {
    merge: [
      "# Title",
      "",
      "Keep",
      "",
      "<<<<<<< HEAD",
      "=======",
      "Status: remote edit",
      "",
      ">>>>>>> other",
      "Footer",
      "",
    ].join("\n"),
    diff3: [
      "# Title",
      "",
      "Keep",
      "",
      "<<<<<<< HEAD",
      "||||||| c770bd8",
      "Status: draft",
      "",
      "=======",
      "Status: remote edit",
      "",
      ">>>>>>> other",
      "Footer",
      "",
    ].join("\n"),
    zdiff3: [
      "# Title",
      "",
      "Keep",
      "",
      "<<<<<<< HEAD",
      "||||||| c770bd8",
      "Status: draft",
      "",
      "=======",
      "Status: remote edit",
      "",
      ">>>>>>> other",
      "Footer",
      "",
    ].join("\n"),
  },
  twoBlocks: {
    merge: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: local edit",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
      "",
      "Middle one",
      "",
      "Middle two",
      "",
      "Middle three",
      "",
      "<<<<<<< HEAD",
      "Owner: me",
      "=======",
      "Owner: them",
      ">>>>>>> other",
      "",
    ].join("\n"),
    diff3: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: local edit",
      "||||||| b2b44d5",
      "Status: draft",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
      "",
      "Middle one",
      "",
      "Middle two",
      "",
      "Middle three",
      "",
      "<<<<<<< HEAD",
      "Owner: me",
      "||||||| b2b44d5",
      "Owner: nobody",
      "=======",
      "Owner: them",
      ">>>>>>> other",
      "",
    ].join("\n"),
    zdiff3: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: local edit",
      "||||||| b2b44d5",
      "Status: draft",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
      "",
      "Middle one",
      "",
      "Middle two",
      "",
      "Middle three",
      "",
      "<<<<<<< HEAD",
      "Owner: me",
      "||||||| b2b44d5",
      "Owner: nobody",
      "=======",
      "Owner: them",
      ">>>>>>> other",
      "",
    ].join("\n"),
  },
  stashLabels: {
    merge: [
      "# Title",
      "",
      "<<<<<<< Updated upstream",
      "Status: upstream edit",
      "=======",
      "Status: stashed edit",
      ">>>>>>> Stashed changes",
      "",
    ].join("\n"),
    diff3: [
      "# Title",
      "",
      "<<<<<<< Updated upstream",
      "Status: upstream edit",
      "||||||| Stash base",
      "Status: draft",
      "=======",
      "Status: stashed edit",
      ">>>>>>> Stashed changes",
      "",
    ].join("\n"),
    zdiff3: [
      "# Title",
      "",
      "<<<<<<< Updated upstream",
      "Status: upstream edit",
      "||||||| Stash base",
      "Status: draft",
      "=======",
      "Status: stashed edit",
      ">>>>>>> Stashed changes",
      "",
    ].join("\n"),
  },
  sharedEdges: {
    merge: [
      "# Title",
      "",
      "Status: final",
      "<<<<<<< HEAD",
      "Owner: me",
      "=======",
      "Owner: them",
      ">>>>>>> other",
      "Due: monday",
      "",
      "Footer",
      "",
    ].join("\n"),
    diff3: [
      "# Title",
      "",
      "<<<<<<< HEAD",
      "Status: final",
      "Owner: me",
      "Due: monday",
      "||||||| 5a5a8a5",
      "Status: draft",
      "Owner: nobody",
      "Due: soon",
      "=======",
      "Status: final",
      "Owner: them",
      "Due: monday",
      ">>>>>>> other",
      "",
      "Footer",
      "",
    ].join("\n"),
    zdiff3: [
      "# Title",
      "",
      "Status: final",
      "<<<<<<< HEAD",
      "Owner: me",
      "||||||| 5a5a8a5",
      "Status: draft",
      "Owner: nobody",
      "Due: soon",
      "=======",
      "Owner: them",
      ">>>>>>> other",
      "Due: monday",
      "",
      "Footer",
      "",
    ].join("\n"),
  },
};

/**
 * The file Git 2.55.0 writes for the same merge of CRLF files, or in a
 * working copy with `core.autocrlf=true`: every line ends in CRLF.
 */
const crlf = (source: string) => source.replaceAll("\n", "\r\n");

// Git 2.55.0 conflicts whose marker lines allow more than one split.
const ambiguousFixtures = {
  // A setext underline of exactly 7 `=` inside "ours" of a `merge` file.
  setext7:
    "# T\n\n<<<<<<< HEAD\nHeading\n=======\n\nlocal\n=======\nStatus: remote edit\n>>>>>>> other\n\nEnd\n",
  // A `||||||| note` line inside "ours" of a `diff3` file.
  barInOurs:
    "# T\n\n<<<<<<< HEAD\nStatus: local\n||||||| note\n||||||| base\nStatus: draft\n=======\nStatus: remote\n>>>>>>> other\n\nEnd\n",
  // A `>>>>>>> quoted` line inside "theirs".
  gtInTheirs:
    "# T\n\n<<<<<<< HEAD\nStatus: local edit\n=======\nStatus: remote edit\n>>>>>>> quoted\nmore\n>>>>>>> other\n\nEnd\n",
  // A `<` line before the block without its own `=` and `>` lines.
  ltBefore:
    "# T\n\n<<<<<<< note\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n\nEnd\n",
};

/** The lines the ambiguous block shows, and the Markdown saved after Edit. */
const ambiguousExpected: Record<
  keyof typeof ambiguousFixtures,
  { lines: string[]; markers: string[]; saved: string }
> = {
  setext7: {
    lines: [
      "<<<<<<< HEAD",
      "Heading",
      "=======",
      "",
      "local",
      "=======",
      "Status: remote edit",
      ">>>>>>> other",
    ],
    markers: ["<<<<<<< HEAD", "=======", "=======", ">>>>>>> other"],
    // The only `<` and `>` lines are the outer markers and stay out.
    saved:
      "# T\n\nHeading\n\n\\=======\n\nlocal\n\n\\=======\n\nStatus: remote edit\n\nEnd\n",
  },
  barInOurs: {
    lines: [
      "<<<<<<< HEAD",
      "Status: local",
      "||||||| note",
      "||||||| base",
      "Status: draft",
      "=======",
      "Status: remote",
      ">>>>>>> other",
    ],
    markers: [
      "<<<<<<< HEAD",
      "||||||| note",
      "||||||| base",
      "=======",
      ">>>>>>> other",
    ],
    saved:
      "# T\n\nStatus: local\n\n||||||| note\n\n||||||| base\n\nStatus: draft\n\n\\=======\n\nStatus: remote\n\nEnd\n",
  },
  gtInTheirs: {
    lines: [
      "<<<<<<< HEAD",
      "Status: local edit",
      "=======",
      "Status: remote edit",
      ">>>>>>> quoted",
      "more",
      ">>>>>>> other",
    ],
    markers: ["<<<<<<< HEAD", "=======", ">>>>>>> quoted", ">>>>>>> other"],
    // Two `>` lines after the separator: both stay as text.
    saved:
      "# T\n\nStatus: local edit\n\n\\=======\n\nStatus: remote edit\n\n\\>>>>>>> quoted\n\nmore\n\n\\>>>>>>> other\n\nEnd\n",
  },
  ltBefore: {
    lines: [
      "<<<<<<< note",
      "",
      "<<<<<<< HEAD",
      "mine",
      "=======",
      "theirs",
      ">>>>>>> other",
    ],
    markers: ["<<<<<<< note", "<<<<<<< HEAD", "=======", ">>>>>>> other"],
    // Two `<` lines: both stay as text.
    saved:
      "# T\n\n\\<\\<\\<\\<\\<\\<\\< note\n\n\\<\\<\\<\\<\\<\\<\\< HEAD\n\nmine\n\n\\=======\n\ntheirs\n\nEnd\n",
  },
};

function conflictSides(value: Descendant[]) {
  return value
    .filter((node) => (node as { type?: string }).type === "conflict")
    .map((node) => {
      const { ours, theirs } = node as unknown as ConflictElement;
      return { ours, theirs };
    });
}

if (process.env.SVODE_PARSE_CONFLICTS_DOM !== "1") {
  const { createPlateEditor } = await import("platejs/react");
  const { EditorKit } = await import("../plate/editor-kit");
  const { deserializeWithConflicts } = await import("./parse-conflicts");
  const { DEFAULT_CONFLICT_MARKER_SIZE } = await import("./conflict-markers");
  const load = (source: string) =>
    deserializeWithConflicts(
      createPlateEditor({ plugins: EditorKit }),
      source,
      DEFAULT_CONFLICT_MARKER_SIZE,
    );

  const expectedSides = {
    oneLine: [{ ours: "Status: local edit", theirs: "Status: remote edit" }],
    emptySide: [{ ours: "", theirs: "Status: remote edit\n" }],
    twoBlocks: [
      { ours: "Status: local edit", theirs: "Status: remote edit" },
      { ours: "Owner: me", theirs: "Owner: them" },
    ],
    stashLabels: [
      { ours: "Status: upstream edit", theirs: "Status: stashed edit" },
    ],
  };
  for (const [name, sides] of Object.entries(expectedSides)) {
    test(`${name}: merge, diff3 and zdiff3 conflicts give the same sides without markers or base`, () => {
      const styles = fixtures[name as keyof typeof expectedSides];
      const merge = load(styles.merge);
      expect(conflictSides(merge)).toEqual(sides);
      expect(load(styles.diff3)).toEqual(merge);
      expect(load(styles.zdiff3)).toEqual(merge);
    });
  }

  test("sharedEdges: zdiff3 matches merge and diff3 keeps whole sides without the base", () => {
    const merge = load(fixtures.sharedEdges.merge);
    expect(conflictSides(merge)).toEqual([
      { ours: "Owner: me", theirs: "Owner: them" },
    ]);
    expect(load(fixtures.sharedEdges.zdiff3)).toEqual(merge);
    expect(conflictSides(load(fixtures.sharedEdges.diff3))).toEqual([
      {
        ours: "Status: final\nOwner: me\nDue: monday",
        theirs: "Status: final\nOwner: them\nDue: monday",
      },
    ]);
  });

  test("CRLF conflicts give the sides of LF conflicts without `\\r` at their edges", () => {
    for (const styles of Object.values(fixtures)) {
      for (const source of Object.values(styles)) {
        const sides = conflictSides(load(crlf(source)));
        expect(sides.length > 0).toBe(true);
        expect(
          sides.map(({ ours, theirs }) => ({
            ours: ours.replaceAll("\r\n", "\n"),
            theirs: theirs.replaceAll("\r\n", "\n"),
          })),
        ).toEqual(conflictSides(load(source)));
        for (const side of sides.flatMap(({ ours, theirs }) => [ours, theirs]))
          expect(/^\r|\r$/.test(side)).toBe(false);
      }
    }
  });

  test("Edit of an ambiguous block resolves a reference link by a definition across a marker line", async () => {
    const { deserializeAmbiguousConflictEdit } =
      await import("./parse-conflicts");
    const nodes = deserializeAmbiguousConflictEdit(
      createPlateEditor({ plugins: EditorKit }),
      [
        { text: "See [the doc][ref]", marker: false },
        { text: "=======", marker: true },
        { text: "\n[ref]: https://example.test/doc", marker: false },
      ],
    );
    const link = JSON.stringify(nodes[0]);
    expect(link.includes('"url":"https://example.test/doc"')).toBe(true);
    expect(nodes[1]).toEqual({ type: "p", children: [{ text: "=======" }] });
  });

  test("conflict choice in an isolated DOM process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PARSE_CONFLICTS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  // Plate's selection and DOM plugins need these beyond the shared set.
  const domGlobals = [
    "Document",
    "NodeList",
    "HTMLCollection",
    "HTMLTextAreaElement",
    "ShadowRoot",
    "DOMRect",
    "Range",
    "Selection",
    "KeyboardEvent",
    "MouseEvent",
    "DOMParser",
  ] as const;

  // The rendered side views of the conflict blocks, ours then theirs.
  const sideViews = (root: ParentNode) =>
    [
      ...root.querySelectorAll(
        '[data-conflict-lane="ours"], [data-conflict-lane="theirs"]',
      ),
    ].map((lane) => lane.querySelector("[data-slate-editor]")!);
  // The text of a side view without its deletions or without its insertions.
  const textWithout = (view: Element, tag: "del" | "ins") => {
    const copy = view.cloneNode(true) as Element;
    for (const node of copy.querySelectorAll(tag)) node.remove();
    return (copy.textContent ?? "").replaceAll("\uFEFF", "").trim();
  };
  const sideTexts = (root: ParentNode) =>
    sideViews(root).map((view) => textWithout(view, "del"));

  test("an ambiguous block shows its whole text and only Edit, which leaves marker lines as text paragraphs", async () => {
    const { createTestDom } = await import("@/shared/testing/dom");
    const dom = await createTestDom();
    for (const key of domGlobals)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: window[key],
      });
    const { MarkdownPlugin } = await import("@platejs/markdown");
    const { Plate, PlateContent, createPlateEditor } =
      await import("platejs/react");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    const { EditorKit } = await import("../plate/editor-kit");
    const { deserializeWithConflicts, hasUnresolvedConflicts } =
      await import("./parse-conflicts");
    const { DEFAULT_CONFLICT_MARKER_SIZE } = await import("./conflict-markers");
    const buttons = (label: string) =>
      [...dom.document.querySelectorAll("button")].filter(
        (button) => button.textContent === label,
      );
    try {
      for (const [name, source] of Object.entries(ambiguousFixtures)) {
        const expected =
          ambiguousExpected[name as keyof typeof ambiguousFixtures];
        const editor = createPlateEditor({
          plugins: EditorKit,
          value: (instance) =>
            deserializeWithConflicts(
              instance,
              source,
              DEFAULT_CONFLICT_MARKER_SIZE,
            ) as Value,
        });
        // The save stays blocked until Edit.
        expect(hasUnresolvedConflicts(editor.children)).toBe(true);
        await dom.render(
          <TooltipProvider>
            <Plate key={name} editor={editor}>
              <PlateContent />
            </Plate>
          </TooltipProvider>,
        );
        // The container of a plain block: the action line with the mark, the
        // title and Edit, then one lane without a side.
        const block = dom.document.querySelector("[data-conflict-lanes]");
        expect(block === null).toBe(false);
        const line = block!.querySelector('[role="group"]')!;
        expect(line.getAttribute("aria-label")).toBe(m.changes_conflict_label());
        expect(line.textContent).toBe(
          `${m.changes_conflict_label()}${m.git_conflict_ambiguous_title()}|${m.git_conflict_edit()}`,
        );
        expect(
          block!.querySelector("[data-conflict-note]")?.textContent,
        ).toBe(m.git_conflict_ambiguous_description());
        expect(
          [...block!.querySelectorAll("[data-conflict-lane]")].map((lane) =>
            lane.getAttribute("data-conflict-lane"),
          ),
        ).toEqual(["neutral"]);
        const panels = [...block!.querySelectorAll("pre")];
        expect(panels.length).toBe(1);
        expect(panels[0].textContent).toBe(expected.lines.join("\n"));
        expect(
          [...panels[0].querySelectorAll("[data-conflict-marker]")].map(
            (line) => line.textContent?.trimEnd(),
          ),
        ).toEqual(expected.markers);
        for (const accept of [
          m.changes_conflict_accept_ours(),
          m.changes_conflict_accept_theirs(),
          m.changes_conflict_accept_both(),
        ])
          expect(buttons(accept)).toEqual([]);
        const edit = buttons(m.git_conflict_edit());
        expect(edit.length).toBe(1);

        await act(async () => edit[0].click());
        expect(hasUnresolvedConflicts(editor.children)).toBe(false);
        const saved = editor.getApi(MarkdownPlugin).markdown.serialize();
        expect(saved).toBe(expected.saved);
        // Reopened, the marker lines are the same text paragraphs.
        const reopened = deserializeWithConflicts(
          createPlateEditor({ plugins: EditorKit }),
          saved,
          DEFAULT_CONFLICT_MARKER_SIZE,
        );
        expect(hasUnresolvedConflicts(reopened)).toBe(false);
        expect(reopened).toEqual(editor.children);
      }

      // A plain block of the same Page keeps its sides and Accept, without Edit.
      const mixed = `${fixtures.twoBlocks.merge.split("\n\nMiddle one")[0]}\n\nMiddle\n\n${ambiguousFixtures.setext7.slice("# T\n\n".length)}`;
      const editor = createPlateEditor({
        plugins: EditorKit,
        value: (instance) =>
          deserializeWithConflicts(
            instance,
            mixed,
            DEFAULT_CONFLICT_MARKER_SIZE,
          ) as Value,
      });
      await dom.render(
        <TooltipProvider>
          <Plate key="mixed" editor={editor}>
            <PlateContent />
          </Plate>
        </TooltipProvider>,
      );
      expect(dom.document.querySelectorAll("[data-conflict-lanes]").length).toBe(
        2,
      );
      expect(buttons(m.changes_conflict_accept_ours()).length).toBe(1);
      expect(buttons(m.changes_conflict_accept_theirs()).length).toBe(1);
      expect(buttons(m.changes_conflict_accept_both()).length).toBe(1);
      expect(buttons(m.git_conflict_edit()).length).toBe(1);
      await act(async () =>
        buttons(m.changes_conflict_accept_ours())[0].click(),
      );
      // The ambiguous block still blocks the save.
      expect(hasUnresolvedConflicts(editor.children)).toBe(true);
      const left = dom.document.querySelectorAll("[data-conflict-lanes]");
      expect(left.length).toBe(1);
      expect(
        left[0].textContent?.includes(m.git_conflict_ambiguous_title()),
      ).toBe(true);
    } finally {
      await dom.dispose();
    }
  }, 30_000);

  test("choosing a side of a zdiff3 conflict in LF and CRLF writes only that side to Markdown", async () => {
    const { createTestDom } = await import("@/shared/testing/dom");
    const dom = await createTestDom();
    for (const key of domGlobals)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: window[key],
      });
    const { MarkdownPlugin } = await import("@platejs/markdown");
    const { Plate, PlateContent, createPlateEditor } =
      await import("platejs/react");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    const { EditorKit } = await import("../plate/editor-kit");
    const { deserializeWithConflicts, hasUnresolvedConflicts } =
      await import("./parse-conflicts");
    const { DEFAULT_CONFLICT_MARKER_SIZE } = await import("./conflict-markers");
    try {
      for (const [index, side, source] of [
        [0, "local", fixtures.oneLine.zdiff3],
        [1, "remote", fixtures.oneLine.zdiff3],
        [0, "local", crlf(fixtures.oneLine.zdiff3)],
        [1, "remote", crlf(fixtures.oneLine.zdiff3)],
      ] as const) {
        const editor = createPlateEditor({
          plugins: EditorKit,
          value: (instance) =>
            deserializeWithConflicts(
              instance,
              source,
              DEFAULT_CONFLICT_MARKER_SIZE,
            ) as Value,
        });
        expect(hasUnresolvedConflicts(editor.children)).toBe(true);
        await dom.render(
          <TooltipProvider>
            <Plate key={`${side}-${source.length}`} editor={editor}>
              <PlateContent />
            </Plate>
          </TooltipProvider>,
        );
        expect(sideTexts(dom.document)).toEqual([
          "Status: local edit",
          "Status: remote edit",
        ]);
        const shown = dom.document.body.textContent ?? "";
        expect(shown.includes("|||||||")).toBe(false);
        expect(shown.includes("Status: draft")).toBe(false);
        const accept = [
          m.changes_conflict_accept_ours(),
          m.changes_conflict_accept_theirs(),
        ].map(
          (label) =>
            [...dom.document.querySelectorAll("button")].filter(
              (button) => button.textContent === label,
            )[0],
        );
        await act(async () => accept[index].click());
        expect(hasUnresolvedConflicts(editor.children)).toBe(false);
        expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
          `# Title\n\nStatus: ${side} edit\n\nFooter\n`,
        );
      }
    } finally {
      await dom.dispose();
    }
  }, 30_000);

  test("a conflict block marks what each side changed in the base, or theirs against ours without one, and accepts mine, incoming or both", async () => {
    const { createTestDom } = await import("@/shared/testing/dom");
    const dom = await createTestDom();
    for (const key of domGlobals)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: window[key],
      });
    const { MarkdownPlugin } = await import("@platejs/markdown");
    const { Plate, PlateContent, createPlateEditor } =
      await import("platejs/react");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    const { EditorKit } = await import("../plate/editor-kit");
    const { deserializeWithConflicts, hasUnresolvedConflicts } =
      await import("./parse-conflicts");
    const { DEFAULT_CONFLICT_MARKER_SIZE } = await import("./conflict-markers");
    const buttons = (label: string) =>
      [...dom.document.querySelectorAll("button")].filter(
        (button) => button.textContent === label,
      );
    let run = 0;
    const open = async (
      source: string,
      bases: (string | null)[],
      readOnly = false,
    ) => {
      const editor = createPlateEditor({
        plugins: EditorKit,
        value: (instance) =>
          deserializeWithConflicts(
            instance,
            source,
            DEFAULT_CONFLICT_MARKER_SIZE,
            bases,
          ) as Value,
      });
      await dom.render(
        <TooltipProvider>
          <Plate key={run++} editor={editor} readOnly={readOnly}>
            <PlateContent />
          </Plate>
        </TooltipProvider>,
      );
      return editor;
    };
    const section = [
      "# Онбординг",
      "",
      "<<<<<<< HEAD",
      "## Первый день",
      "",
      "- Получить доступы и встретиться с командой.",
      "- Настроить **рабочее** место.",
      "=======",
      "## Первый день",
      "",
      "- Получить доступы, ноутбук и пропуск.",
      "- Настроить рабочее место.",
      ">>>>>>> other",
      "",
      "Конец",
      "",
    ].join("\n");
    const base = [
      "## Первый день",
      "",
      "- Получить доступы.",
      "- Настроить рабочее место.",
    ].join("\n");
    try {
      // With a base: each side is rendered text marked against it.
      let editor = await open(section, [base]);
      const block = dom.document.querySelector("[data-conflict-lanes]")!;
      // No frame or title: the action line, then the lanes of the sides.
      expect(block.className.includes("border")).toBe(false);
      expect(block.textContent?.includes("⚠")).toBe(false);
      expect([...block.children].map((child) => child.tagName)).toEqual([
        "DIV",
        "DIV",
      ]);
      const line = block.querySelector('[role="group"]')!;
      expect(line.getAttribute("aria-label")).toBe(m.changes_conflict_label());
      expect(line.textContent).toBe(
        [
          m.changes_conflict_label(),
          m.changes_conflict_accept_ours(),
          "|",
          m.changes_conflict_accept_theirs(),
          "|",
          m.changes_conflict_accept_both(),
        ].join(""),
      );
      expect(
        [...line.querySelectorAll("button")].map((action) => [
          action.textContent,
          action.getAttribute("data-variant"),
        ]),
      ).toEqual(
        [
          m.changes_conflict_accept_ours(),
          m.changes_conflict_accept_theirs(),
          m.changes_conflict_accept_both(),
        ].map((label) => [label, "link"]),
      );
      expect(block.textContent?.includes(m.git_conflict_no_base())).toBe(false);
      const lanes = [...block.querySelectorAll("[data-conflict-lane]")];
      expect(
        lanes.map((lane) => [
          lane.getAttribute("data-conflict-lane"),
          lane.getAttribute("aria-label"),
          lane.firstElementChild?.textContent,
        ]),
      ).toEqual([
        ["ours", m.changes_conflict_ours(), m.changes_conflict_ours()],
        ["theirs", m.changes_conflict_theirs(), m.changes_conflict_theirs()],
      ]);
      expect(lanes[0].className.includes("bg-(--conflict-ours)")).toBe(true);
      expect(lanes[1].className.includes("bg-(--conflict-theirs)")).toBe(true);
      // Marks in the tones of the lane.
      for (const lane of lanes) {
        expect(lane.querySelectorAll("ins").length > 0).toBe(true);
        for (const mark of lane.querySelectorAll("ins"))
          expect(mark.className.includes("bg-(--conflict-lane-insert)")).toBe(
            true,
          );
      }
      expect(block.querySelectorAll("pre").length).toBe(0);
      const baseText = "Первый деньПолучить доступы.Настроить рабочее место.";
      const [ours, theirs] = sideViews(block);
      for (const view of [ours, theirs]) {
        expect(view.querySelector("h2")?.textContent).toBe("Первый день");
        expect(view.querySelectorAll("li").length).toBe(2);
        expect(view.querySelectorAll("ins").length > 0).toBe(true);
        expect(textWithout(view, "ins")).toBe(baseText);
      }
      expect(textWithout(ours, "del")).toBe(
        "Первый деньПолучить доступы и встретиться с командой.Настроить рабочее место.",
      );
      expect(textWithout(theirs, "del")).toBe(
        "Первый деньПолучить доступы, ноутбук и пропуск.Настроить рабочее место.",
      );
      expect(ours.querySelector("strong")?.textContent).toBe("рабочее");
      // Three equal actions, no Edit; the save waits for a choice.
      for (const label of [
        m.changes_conflict_accept_ours(),
        m.changes_conflict_accept_theirs(),
        m.changes_conflict_accept_both(),
      ])
        expect(buttons(label).length).toBe(1);
      expect(buttons(m.git_conflict_edit()).length).toBe(0);
      expect(hasUnresolvedConflicts(editor.children)).toBe(true);
      await act(async () =>
        buttons(m.changes_conflict_accept_both())[0].click(),
      );
      expect(hasUnresolvedConflicts(editor.children)).toBe(false);
      expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
        [
          "# Онбординг",
          "",
          "## Первый день",
          "",
          "- Получить доступы и встретиться с командой.",
          "- Настроить **рабочее** место.",
          "",
          "## Первый день",
          "",
          "- Получить доступы, ноутбук и пропуск.",
          "- Настроить рабочее место.",
          "",
          "Конец",
          "",
        ].join("\n"),
      );

      // Without a base, or when the bases do not read: theirs against ours.
      for (const bases of [[null], []]) {
        editor = await open(section, bases);
        const plain = dom.document.querySelector("[data-conflict-lanes]")!;
        // The line about the base stands between the actions and the lanes.
        expect(
          [...plain.children].map(
            (child) =>
              (child.hasAttribute("data-conflict-actions") && "actions") ||
              (child.hasAttribute("data-conflict-note") && child.textContent) ||
              "lanes",
          ),
        ).toEqual(["actions", m.git_conflict_no_base(), "lanes"]);
        for (const mark of plain.querySelectorAll("del"))
          expect(mark.className.includes("text-(--conflict-delete)")).toBe(
            true,
          );
        const [mine, incoming] = sideViews(plain);
        expect(mine.querySelectorAll("ins, del").length).toBe(0);
        expect(textWithout(incoming, "ins")).toBe(textWithout(mine, "del"));
        expect(textWithout(incoming, "del")).toBe(
          "Первый деньПолучить доступы, ноутбук и пропуск.Настроить рабочее место.",
        );
        expect(incoming.querySelectorAll("ins").length > 0).toBe(true);
        expect(incoming.querySelectorAll("del").length > 0).toBe(true);
      }

      // A side that removed the text of the block shows the base deleted; an
      // empty base shows each side inserted.
      editor = await open(fixtures.emptySide.merge, ["Status: draft"]);
      const [removed, edited] = sideViews(dom.document);
      expect(textWithout(removed, "del")).toBe("");
      expect(textWithout(removed, "ins")).toBe("Status: draft");
      expect(textWithout(edited, "del")).toBe("Status: remote edit");
      // Both, with mine empty, is incoming alone.
      await act(async () =>
        buttons(m.changes_conflict_accept_both())[0].click(),
      );
      expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
        "# Title\n\nKeep\n\nStatus: remote edit\n\nFooter\n",
      );
      editor = await open(fixtures.oneLine.merge, [""]);
      for (const view of sideViews(dom.document)) {
        expect(textWithout(view, "ins")).toBe("");
        expect(view.querySelectorAll("del").length).toBe(0);
      }
      expect(
        dom.document.body.textContent?.includes(m.git_conflict_no_base()),
      ).toBe(false);

      // Accept mine and incoming put that side alone in place of the block.
      for (const [label, side] of [
        [m.changes_conflict_accept_ours(), "local"],
        [m.changes_conflict_accept_theirs(), "remote"],
      ] as const) {
        editor = await open(fixtures.oneLine.merge, ["Status: draft"]);
        await act(async () => buttons(label)[0].click());
        expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
          `# Title\n\nStatus: ${side} edit\n\nFooter\n`,
        );
      }

      // Read only: the actions are unavailable.
      await open(fixtures.oneLine.merge, ["Status: draft"], true);
      for (const label of [
        m.changes_conflict_accept_ours(),
        m.changes_conflict_accept_theirs(),
        m.changes_conflict_accept_both(),
      ])
        expect(buttons(label)[0].disabled).toBe(true);
    } finally {
      await dom.dispose();
    }
  }, 30_000);
}
