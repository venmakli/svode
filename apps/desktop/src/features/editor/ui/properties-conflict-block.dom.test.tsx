import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import type { Descendant, TElement } from "platejs";
import type { Page } from "@/features/page";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";
import type { ConflictElement } from "../conflict/parse-conflicts";

if (process.env.SVODE_PROPERTIES_CONFLICT_DOM !== "1") {
  test("the properties block of a Page with its frontmatter in conflict", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PROPERTIES_CONFLICT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
  }, 60_000);
} else {
  // Radix picks its layout effect when it loads: the modules load once a DOM
  // exists.
  const preload = await createTestDom();
  const { NodeApi } = await import("platejs");
  const { createPlateEditor } = await import("platejs/react");
  const m = await import("@/paraglide/messages.js");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { useEditorDocumentWriter } =
    await import("../hooks/use-editor-document-writer");
  const { deserializeEditorMarkdownInsertion } =
    await import("../model/markdown-io");
  const { loadProgrammaticEditorValue } =
    await import("../model/programmatic-editor-load");
  const { getPropertiesConflict } =
    await import("../model/properties-conflict");
  const { EditorKit } = await import("../plate/editor-kit");
  const { PropertiesConflictBlock } =
    await import("./properties-conflict-block");
  await preload.dispose();

  const SPACE = "/space";

  /** Git 2.55 `merge` style: adjacent fields and the heading edited on both sides. */
  const PLAN_FRONTMATTER = [
    "---",
    'title: "Release \\"Q4\\" plan"',
    "<<<<<<< ours",
    "status: done",
    "due: 2026-11-15",
    "=======",
    "status: blocked",
    'due: "2026-12-01"',
    ">>>>>>> theirs",
    "owner: 'Ann_Lee'",
    "tags:",
    "  - plan",
    "description: |",
    "  First line with *stars* and [brackets]",
    "  Second line ends with backslash \\",
    "# a YAML comment",
    "---",
    "",
  ].join("\n");
  const PLAN_TEXT = [
    "<<<<<<< ours",
    "# Heading mine",
    "=======",
    "# Heading theirs",
    ">>>>>>> theirs",
    "",
    "Body text.",
    "",
  ].join("\n");
  const PLAN = PLAN_FRONTMATTER + PLAN_TEXT;
  /** The frontmatter `git merge-file --theirs` gives, as Svode resolves it. */
  const PLAN_THEIRS = PLAN_FRONTMATTER.replace(
    "<<<<<<< ours\nstatus: done\ndue: 2026-11-15\n=======\n",
    "",
  ).replace(">>>>>>> theirs\n", "");

  /** A Collection record with a conflict only in its fields. */
  const RECORD = [
    "---",
    "title: Fix login",
    "unique_id: 12",
    "<<<<<<< ours",
    "status: Done",
    "estimate: 5",
    "=======",
    "status: Blocked",
    "estimate: 8",
    ">>>>>>> theirs",
    "---",
    "Steps to reproduce.",
    "",
  ].join("\n");
  const RECORD_OURS = [
    "---",
    "title: Fix login",
    "unique_id: 12",
    "status: Done",
    "estimate: 5",
    "---",
    "",
  ].join("\n");

  /** A place through the closing `---` and the first line of the text. */
  const NOTES = [
    "---",
    "title: Notes",
    "<<<<<<< ours",
    "reviewed: 2026-10-20",
    "---",
    "# Notes mine",
    "=======",
    "reviewed: 2026-10-25",
    "---",
    "# Notes theirs",
    ">>>>>>> theirs",
    "",
    "Text.",
    "",
  ].join("\n");

  const frontmatterEnd = (file: string) =>
    /^---\n[\s\S]*?\n---\n/.exec(file)?.[0] ?? "";

  /** The places Svode reads in the frontmatter of the fixtures. */
  function propertiesOf(content: string) {
    if (content === PLAN)
      return {
        places: {
          type: "places",
          places: [
            {
              startLine: 2,
              endLine: 8,
              ours: "status: done\ndue: 2026-11-15",
              theirs: 'status: blocked\ndue: "2026-12-01"',
            },
          ],
        },
        body: PLAN_TEXT,
        reachesText: false,
      };
    if (content === RECORD)
      return {
        places: {
          type: "places",
          places: [
            {
              startLine: 3,
              endLine: 9,
              ours: "status: Done\nestimate: 5",
              theirs: "status: Blocked\nestimate: 8",
            },
          ],
        },
        body: "Steps to reproduce.\n",
        reachesText: false,
      };
    if (content === NOTES)
      return {
        places: {
          type: "places",
          places: [
            {
              startLine: 2,
              endLine: 10,
              ours: "reviewed: 2026-10-20\n---\n# Notes mine",
              theirs: "reviewed: 2026-10-25\n---\n# Notes theirs",
            },
          ],
        },
        body: "\nText.\n",
        reachesText: true,
      };
    return null;
  }

  function page(path: string, file: string, version: string): Page {
    // As the core reads a source: frontmatter with marker lines does not read,
    // and the whole file comes as the body with a warning.
    const frontmatter = frontmatterEnd(file);
    const readable = frontmatter !== "" && !frontmatter.includes("<<<<<<<");
    return {
      path,
      body: readable ? file.slice(frontmatter.length) : file,
      source_version: version,
      meta: { title: "Plan", icon: null, created: "", updated: "", extra: {} },
      warnings: readable
        ? []
        : [{ kind: "malformed_frontmatter", message: "invalid YAML" }],
    } as Page;
  }

  interface Options {
    resolve?: (choices: string[]) => unknown;
    properties?: (content: string) => unknown;
  }

  async function harness(path: string, file: string, options: Options = {}) {
    const dom = await createTestDom();
    const disk = { file, version: "v1" };
    const writes: string[] = [];
    const resolutions: { choices: string[]; markerSize: number }[] = [];
    const sides: unknown[] = [];
    const baseContents: string[] = [];
    let reads = 0;
    mockNativeIpc(
      (command, args) => {
        const input = args as Record<string, unknown>;
        if (command === "read_page") {
          reads += 1;
          return page(path, disk.file, disk.version);
        }
        if (command === "write_page_body") {
          if (input.sourceVersion !== disk.version)
            throw { kind: "source_stale" };
          const content = input.content as string;
          writes.push(content);
          // The core writes a source whose frontmatter does not read as sent,
          // otherwise it keeps the frontmatter and replaces the body.
          const current = page(path, disk.file, disk.version);
          disk.file = current.warnings?.length
            ? content
            : frontmatterEnd(disk.file) + content;
          disk.version = `v${writes.length + 1}`;
          return {
            write_nonce: `n${writes.length}`,
            source_version: disk.version,
          };
        }
        if (command === "git_conflict_marker_size") return 7;
        if (command === "git_page_conflict_bases") {
          baseContents.push(input.content as string);
          return ["# Heading base"];
        }
        if (command === "git_page_properties_conflict")
          return (options.properties ?? propertiesOf)(input.content as string);
        if (command === "git_resolve_page_properties") {
          const choices = input.choices as string[];
          resolutions.push({ choices, markerSize: input.markerSize as number });
          return options.resolve
            ? options.resolve(choices)
            : {
                type: "resolved",
                frontmatter: resolved(input.content, choices),
              };
        }
        if (command === "git_conflict_file")
          return {
            path,
            kind: "page_properties",
            version: "x",
            content: null,
            places: { type: "unclear", reason: "ambiguous" },
            ours: true,
            theirs: true,
          };
        if (command === "git_resolve_conflict_file") {
          sides.push(input.resolution);
          return { type: "resolved" };
        }
        if (command === "git_status")
          return {
            branch: "main",
            ahead: 0,
            behind: 0,
            hasStaged: false,
            hasUnstaged: false,
            hasConflicts: false,
            tracking: null,
            files: [],
            totalFiles: 0,
            omittedFiles: 0,
          };
        return null;
      },
      { shouldMockEvents: true },
    );

    const editor = createPlateEditor({ plugins: EditorKit });
    const ref = <T,>(current: T) => ({ current });
    const debounceTimerRef = ref<ReturnType<typeof setTimeout> | null>(null);
    const writerRef = ref<ReturnType<typeof useEditorDocumentWriter> | null>(
      null,
    );
    const noop = () => {};
    const key = `${SPACE}\0${path}`;
    let resolvedCalls = 0;

    function View() {
      const writer = useEditorDocumentWriter({
        activeWsId: null,
        bufferTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
        cancelDebounce: () => {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        },
        clearUnsaved: noop,
        currentCacheKeyRef: ref<string | null>(key),
        currentDocument: path,
        currentPathRef: ref<string | null>(path),
        debounceTimerRef,
        descriptionRef: ref(""),
        editor,
        iconRef: ref<string | null>(null),
        isDebouncePendingRef: ref(false),
        isLoadingRef: ref(false),
        loadEditorValue: (value: Descendant[]) =>
          loadProgrammaticEditorValue(editor, value),
        onSourcePageLoaded: noop,
        onSourceMetadata: noop,
        ownNoncesRef: ref(new Set<string>()),
        patchPageTreeMeta: noop,
        projectPath: null,
        saveScopeTree: [],
        spacePath: SPACE,
        titleRef: ref("Plan"),
        readOnly: false,
      });
      useEffect(() => {
        writerRef.current = writer;
      });
      return (
        <PropertiesConflictBlock
          documentKey={key}
          spacePath={SPACE}
          path={path}
          readOnly={false}
          onResolved={() => (resolvedCalls += 1)}
        />
      );
    }

    await dom.render(
      <ThemeProvider theme="light" setTheme={noop}>
        <View />
      </ThemeProvider>,
    );
    await act(() => writerRef.current!.discardPendingSource());

    const settle = () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, 20));
      });
    const click = async (element: Element | null | undefined) => {
      expect(element == null).toBe(false);
      await act(async () => {
        (element as HTMLElement).click();
        await new Promise((done) => setTimeout(done, 20));
      });
    };
    const sideButton = (side: "ours" | "theirs", place = 0) =>
      dom.document.querySelector(
        `[data-properties-place="${place}"] [data-properties-side=${side}] button`,
      );
    const button = (text: string, root: ParentNode = dom.document) =>
      Array.from(root.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === text,
      );

    return {
      dom,
      editor,
      disk,
      writes,
      resolutions,
      sides,
      baseContents,
      reads: () => reads,
      resolvedCalls: () => resolvedCalls,
      state: () => getPropertiesConflict(key),
      block: () => dom.document.querySelector("[data-properties-conflict]"),
      settle,
      click,
      sideButton,
      button,
      text: () =>
        editor.children.map((node) => NodeApi.string(node)).join("\n"),
      /** Saves the editor as autosave does once its debounce is due. */
      save: async () => {
        debounceTimerRef.current = setTimeout(noop, 60_000);
        await act(() => writerRef.current!.flushPendingSource());
      },
      /** Takes a side of the first text block the way the conflict block does. */
      acceptText: (side: "ours" | "theirs") => {
        const index = editor.children.findIndex(
          (node) => (node as TElement).type === "conflict",
        );
        const conflict = editor.children[index] as unknown as ConflictElement;
        editor.tf.removeNodes({ at: [index] });
        editor.tf.insertNodes(
          deserializeEditorMarkdownInsertion(
            editor,
            conflict[side].trim() + "\n",
          ) as never,
          { at: [index] },
        );
      },
      cleanup: async () => {
        await dom.render(null);
        clearNativeMocks();
        await dom.dispose();
      },
    };
  }

  /** The frontmatter of the fixture with the lines of the chosen sides. */
  function resolved(content: unknown, choices: string[]): string {
    if (content === PLAN)
      return choices[0] === "theirs"
        ? PLAN_THEIRS
        : PLAN_FRONTMATTER.replace(
            /=======\nstatus: blocked\ndue: "2026-12-01"\n>>>>>>> theirs\n/,
            "",
          ).replace("<<<<<<< ours\n", "");
    if (content === RECORD) return RECORD_OURS;
    if (content === NOTES)
      return choices[0] === "theirs"
        ? "---\ntitle: Notes\nreviewed: 2026-10-25\n---\n# Notes theirs\n"
        : "---\ntitle: Notes\nreviewed: 2026-10-20\n---\n# Notes mine\n";
    throw new Error("unexpected content");
  }

  test("the frontmatter in conflict stays out of the editor, blocks the save and is written as chosen before the text", async () => {
    const view = await harness("pages/plan.md", PLAN);
    try {
      // The editor gets only the text, with its own conflict block.
      expect(view.text().includes("owner")).toBe(false);
      expect(view.text().includes("title")).toBe(false);
      expect(
        view.editor.children.some(
          (node) => (node as TElement).type === "conflict",
        ),
      ).toBe(true);
      const block = view.block()!;
      expect(
        block.textContent?.includes(m.editor_properties_conflict_title()),
      ).toBe(true);
      // The lines of both sides as they are.
      const lines = Array.from(block.querySelectorAll("pre")).map(
        (pre) => pre.textContent,
      );
      expect(lines).toEqual([
        "status: done\ndue: 2026-11-15",
        'status: blocked\ndue: "2026-12-01"',
      ]);

      // Nothing is written while the block is not resolved.
      view.acceptText("theirs");
      await view.save();
      expect(view.writes).toEqual([]);

      await view.click(view.sideButton("theirs"));
      expect(view.resolutions).toEqual([
        { choices: ["theirs"], markerSize: 7 },
      ]);
      expect(view.resolvedCalls()).toBe(1);
      expect(view.sideButton("theirs")!.getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(
        view.block()!.querySelector("[data-properties-resolved]") === null,
      ).toBe(false);

      await view.save();
      expect(view.writes).toEqual([
        PLAN_THEIRS + "# Heading theirs\n\nBody text.\n",
      ]);
      // The file now reads; the block is gone and later saves write the body.
      expect(view.state()).toBe(null);
      await view.settle();
      expect(view.block()).toBe(null);
      view.editor.tf.insertText("!", { at: view.editor.api.end([]) });
      await view.save();
      expect(view.writes.at(-1)).toBe("# Heading theirs\n\nBody text.!\n");
      expect(view.disk.file.startsWith(PLAN_THEIRS)).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  test("a text conflict still blocks the save after the properties are chosen", async () => {
    const view = await harness("pages/plan.md", PLAN);
    try {
      // The bases are read for the text after the frontmatter.
      expect(view.baseContents).toEqual([PLAN_TEXT]);
      const conflict = view.editor.children.find(
        (node) => (node as TElement).type === "conflict",
      ) as unknown as ConflictElement;
      expect(conflict.base).toBe("# Heading base");
      await view.click(view.sideButton("ours"));
      await view.save();
      expect(view.writes).toEqual([]);
      // A changed choice is checked again.
      await view.click(view.sideButton("theirs"));
      expect(view.resolutions.map((call) => call.choices)).toEqual([
        ["ours"],
        ["theirs"],
      ]);
      view.acceptText("ours");
      await view.save();
      expect(view.writes).toEqual([
        PLAN_THEIRS + "# Heading mine\n\nBody text.\n",
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a Collection record in conflict only in its fields saves the chosen side word for word", async () => {
    const view = await harness("tasks/fix-login.md", RECORD);
    try {
      expect(view.text()).toBe("Steps to reproduce.");
      await view.click(view.sideButton("ours"));
      await view.save();
      expect(view.writes).toEqual([RECORD_OURS + "Steps to reproduce.\n"]);
    } finally {
      await view.cleanup();
    }
  });

  test("a place through the closing delimiter is resolved in the block and its text lines open the body", async () => {
    const view = await harness("pages/notes.md", NOTES);
    try {
      expect(view.text()).toBe("Text.");
      expect(view.block()!.querySelectorAll("pre")[0].textContent).toBe(
        "reviewed: 2026-10-20\n---\n# Notes mine",
      );
      await view.click(view.sideButton("theirs"));
      const reads = view.reads();
      await view.save();
      expect(view.writes).toEqual([
        "---\ntitle: Notes\nreviewed: 2026-10-25\n---\n# Notes theirs\n\nText.\n",
      ]);
      // The editor reads the file again: the chosen heading is its text now.
      expect(view.reads()).toBe(reads + 1);
      expect(view.text()).toBe("Notes theirs\nText.");
      await view.save();
      expect(view.writes.at(-1)).toBe("# Notes theirs\n\nText.\n");
    } finally {
      await view.cleanup();
    }
  });

  test("a frontmatter that does not read shows the error and keeps the save blocked", async () => {
    const view = await harness("tasks/fix-login.md", RECORD, {
      resolve: () => ({
        type: "unresolved",
        finding: { type: "unreadable", message: "duplicate key" },
      }),
    });
    try {
      await view.click(view.sideButton("theirs"));
      expect(view.resolvedCalls()).toBe(0);
      const alert = view.dom.document.querySelector(
        "[data-conflict-problem=unreadable]",
      )!;
      expect(
        alert.textContent?.includes(
          m.changes_conflict_unreadable({ message: "duplicate key" }),
        ),
      ).toBe(true);
      await view.save();
      expect(view.writes).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });

  test("an ambiguous place warns and takes a side for the whole Page after confirmation", async () => {
    const view = await harness("tasks/fix-login.md", RECORD, {
      properties: () => ({
        places: { type: "unclear", reason: "ambiguous" },
        body: "Steps to reproduce.\n",
        reachesText: false,
      }),
    });
    try {
      await view.settle();
      const block = view.block()!;
      expect(block.querySelector("[data-properties-place]")).toBe(null);
      expect(
        block
          .querySelector("[data-conflict-unclear=ambiguous]")
          ?.textContent?.includes(m.changes_conflict_unclear_ambiguous()),
      ).toBe(true);
      await view.save();
      expect(view.writes).toEqual([]);
      await view.click(block.querySelector("[data-conflict-whole=theirs]"));
      expect(view.sides).toEqual([]);
      const dialog = view.dom.document.querySelector("[role=alertdialog]")!;
      expect(
        dialog.textContent?.includes(
          m.changes_conflict_take_theirs_description(),
        ),
      ).toBe(true);
      await view.click(view.button(m.changes_conflict_take_theirs(), dialog));
      expect(view.sides).toEqual([{ type: "side", side: "theirs" }]);
    } finally {
      await view.cleanup();
    }
  });

  test("a frontmatter without marker lines opens as before", async () => {
    const view = await harness(
      "pages/plain.md",
      "---\ntitle: Plain\n---\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n",
    );
    try {
      expect(view.state()).toBe(null);
      expect(view.block()).toBe(null);
      expect(
        view.editor.children.some(
          (node) => (node as TElement).type === "conflict",
        ),
      ).toBe(true);
    } finally {
      await view.cleanup();
    }
  });
}
