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
  test("choosing a side of a zdiff3 conflict in LF and CRLF writes only that side to Markdown", async () => {
    const { createTestDom } = await import("@/shared/testing/dom");
    const dom = await createTestDom();
    // Plate's selection and DOM plugins need these beyond the shared set.
    for (const key of [
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
    ] as const) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: window[key],
      });
    }
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
        const sides = [...dom.document.querySelectorAll("pre")].map(
          (pre) => pre.textContent,
        );
        expect(sides).toEqual(["Status: local edit", "Status: remote edit"]);
        const shown = dom.document.body.textContent ?? "";
        expect(shown.includes("|||||||")).toBe(false);
        expect(shown.includes("Status: draft")).toBe(false);
        const accept = [...dom.document.querySelectorAll("button")].filter(
          (button) => button.textContent === m.git_conflict_accept(),
        );
        expect(accept.length).toBe(2);
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
}
