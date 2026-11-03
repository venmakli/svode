import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import type { Descendant, TElement } from "platejs";
import type { Page } from "@/features/page";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";
import type { ConflictElement } from "../conflict/parse-conflicts";

// A Page whose frontmatter is in conflict in the editor (DF-292 R2, R4, R5):
// the editor gets the text below the properties merged as text, nothing is
// written until every disputed property and text block is decided, then the
// Page is written once as Svode composes it from the decisions.
if (process.env.SVODE_EDITOR_PAGE_MERGE_DOM !== "1") {
  test("the editor of a Page with its frontmatter in conflict", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_EDITOR_PAGE_MERGE_DOM: "1" },
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
  const { useEditorDocumentWriter } =
    await import("./use-editor-document-writer");
  const { deserializeEditorMarkdownInsertion } =
    await import("../model/markdown-io");
  const { loadProgrammaticEditorValue } =
    await import("../model/programmatic-editor-load");
  const { EditorKit } = await import("../plate/editor-kit");
  const {
    acceptPageMerge,
    decidePageMergeProperty,
    getPageMergeState,
    setPageMerge,
  } = await import("@/features/page");
  await preload.dispose();

  const SPACE = "/space";
  const PATH = "Онбординг.md";

  /** The working file Git leaves: marker lines in the frontmatter and text. */
  const ONBOARDING = [
    "---",
    "title: Онбординг",
    "<<<<<<< ours",
    "status: На проверке",
    "owner: Борис",
    "=======",
    "status: Готово",
    "owner: Анна Ли",
    ">>>>>>> theirs",
    "due: 2026-11-10",
    "---",
    "Вводный абзац.",
    "",
    "<<<<<<< ours",
    "Получить доступы, ноутбук и пропуск.",
    "=======",
    "Получить доступы и встретиться с командой.",
    ">>>>>>> theirs",
    "",
  ].join("\n");
  /** The text below the properties merged as text from the index stages. */
  const MERGED_TEXT = [
    "Вводный абзац.",
    "",
    "<<<<<<< ours",
    "Получить доступы, ноутбук и пропуск.",
    "=======",
    "Получить доступы и встретиться с командой.",
    ">>>>>>> theirs",
    "",
  ].join("\n");
  const MERGE = {
    type: "merged",
    body: MERGED_TEXT,
    properties: [
      {
        key: "title",
        base: "Онбординг",
        ours: "Онбординг",
        theirs: "Онбординг",
        disputed: false,
        merged: "Онбординг",
      },
      {
        key: "status",
        base: "Черновик",
        ours: "На проверке",
        theirs: "Готово",
        disputed: true,
      },
      {
        key: "owner",
        base: "Анна",
        ours: "Борис",
        theirs: "Анна Ли",
        disputed: true,
      },
      {
        key: "due",
        base: "2026-11-10",
        ours: "2026-11-10",
        theirs: "2026-11-10",
        disputed: false,
        merged: "2026-11-10",
      },
    ],
  };

  interface Options {
    file?: string;
    merge?: unknown;
    compose?: (input: Record<string, unknown>) => unknown;
  }

  function page(file: string, version: string): Page {
    const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(file)?.[0] ?? "";
    const readable = frontmatter !== "" && !frontmatter.includes("<<<<<<<");
    return {
      path: PATH,
      body: readable ? file.slice(frontmatter.length) : file,
      source_version: version,
      meta: {
        title: "Онбординг",
        icon: null,
        created: "",
        updated: "",
        extra: {},
      },
      warnings: readable
        ? []
        : [{ kind: "malformed_frontmatter", message: "invalid YAML" }],
    } as Page;
  }

  /** What Svode composes for the fixture: the decided values, then the text. */
  function composed(input: Record<string, unknown>): string {
    const decisions = input.decisions as Record<
      string,
      { type: string; value?: unknown }
    >;
    const value = (key: string, ours: string, theirs: string) => {
      const decision = decisions[key];
      if (decision.type === "value") return String(decision.value);
      return decision.type === "ours" ? ours : theirs;
    };
    return (
      "---\ntitle: Онбординг\n" +
      `status: ${value("status", "На проверке", "Готово")}\n` +
      `owner: ${value("owner", "Борис", "Анна Ли")}\n` +
      "due: 2026-11-10\n---\n" +
      (input.body as string)
    );
  }

  async function harness(options: Options = {}) {
    const dom = await createTestDom();
    const disk = { file: options.file ?? ONBOARDING, version: "v1" };
    const writes: string[] = [];
    const composes: Record<string, unknown>[] = [];
    const baseContents: string[] = [];
    const mergeReads: unknown[] = [];
    mockNativeIpc(
      (command, args) => {
        const input = args as Record<string, unknown>;
        if (command === "read_page") return page(disk.file, disk.version);
        if (command === "write_page_body") {
          if (input.sourceVersion !== disk.version)
            throw { kind: "source_stale" };
          writes.push(input.content as string);
          disk.file = input.content as string;
          disk.version = `v${writes.length + 1}`;
          return {
            write_nonce: `n${writes.length}`,
            source_version: disk.version,
          };
        }
        if (command === "git_conflict_marker_size") return 7;
        if (command === "git_page_merge") {
          mergeReads.push(input);
          return options.merge ?? MERGE;
        }
        if (command === "git_page_conflict_bases") {
          baseContents.push(input.content as string);
          return ["Получить доступы и пройти обзор продукта."];
        }
        if (command === "git_compose_page_merge") {
          composes.push(input);
          return options.compose
            ? options.compose(input)
            : { type: "composed", content: composed(input) };
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

    function View() {
      const writer = useEditorDocumentWriter({
        activeWsId: null,
        bufferTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
        cancelDebounce: () => {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        },
        clearUnsaved: noop,
        currentCacheKeyRef: ref<string | null>(`${SPACE}\0${PATH}`),
        currentDocument: PATH,
        currentPathRef: ref<string | null>(PATH),
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
        titleRef: ref("Онбординг"),
        readOnly: false,
      });
      useEffect(() => {
        writerRef.current = writer;
      });
      return null;
    }

    await dom.render(<View />);
    // Loads the source as the editor does.
    await act(() => writerRef.current!.discardPendingSource());

    return {
      editor,
      disk,
      writes,
      composes,
      baseContents,
      mergeReads,
      state: () => getPageMergeState(SPACE, PATH),
      decide: (
        key: string,
        decision: Parameters<typeof decidePageMergeProperty>[3],
      ) => act(async () => decidePageMergeProperty(SPACE, PATH, key, decision)),
      accept: () => act(async () => acceptPageMerge(SPACE, PATH, true)),
      text: () =>
        editor.children.map((node) => NodeApi.string(node)).join("\n"),
      hasTextBlock: () =>
        editor.children.some((node) => (node as TElement).type === "conflict"),
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
        setPageMerge(SPACE, PATH, null);
        clearNativeMocks();
        await dom.dispose();
      },
    };
  }

  test("the editor gets the merged text below the properties and writes the Page once every property and block is decided", async () => {
    const view = await harness();
    try {
      // No line of the frontmatter reaches the editor; its text block does.
      expect(view.text().includes("status")).toBe(false);
      expect(view.text().includes("title")).toBe(false);
      expect(view.hasTextBlock()).toBe(true);
      expect(view.mergeReads).toEqual([{ spacePath: SPACE, path: PATH }]);
      // The bases are read for the merged text.
      expect(view.baseContents).toEqual([MERGED_TEXT]);
      expect(view.state()?.merge.type).toBe("merged");

      // Nothing is written while a disputed property is open.
      view.acceptText("theirs");
      await view.save();
      expect(view.writes).toEqual([]);
      await view.decide("status", { type: "theirs" });
      await view.save();
      expect(view.writes).toEqual([]);
      expect(view.composes).toEqual([]);

      await view.decide("owner", { type: "value", value: "Вера" });
      await view.save();
      expect(view.composes.length).toBe(1);
      expect(view.composes[0]!.decisions).toEqual({
        status: { type: "theirs" },
        owner: { type: "value", value: "Вера" },
      });
      const body = view.composes[0]!.body as string;
      expect(body).toBe(
        "Вводный абзац.\n\nПолучить доступы и встретиться с командой.\n",
      );
      // One write: the Page as Svode composes it, then the properties leave
      // the conflict mode.
      expect(view.writes).toEqual([
        "---\ntitle: Онбординг\nstatus: Готово\nowner: Вера\ndue: 2026-11-10\n---\n" +
          body,
      ]);
      expect(view.state()).toBe(null);
    } finally {
      await view.cleanup();
    }
  });

  test("a text block still blocks the write after the properties are decided", async () => {
    const view = await harness();
    try {
      await view.decide("status", { type: "ours" });
      await view.decide("owner", { type: "ours" });
      await view.save();
      expect(view.composes).toEqual([]);
      expect(view.writes).toEqual([]);
      view.acceptText("ours");
      await view.save();
      expect(view.writes).toEqual([
        "---\ntitle: Онбординг\nstatus: На проверке\nowner: Борис\ndue: 2026-11-10\n---\n" +
          "Вводный абзац.\n\nПолучить доступы, ноутбук и пропуск.\n",
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a refused composition writes nothing, names the reason and keeps the decisions", async () => {
    let refuse = true;
    const view = await harness({
      compose: (input) =>
        refuse
          ? {
              type: "unresolved",
              finding: { type: "unreadable", message: "invalid date" },
            }
          : { type: "composed", content: composed(input) },
    });
    try {
      view.acceptText("ours");
      await view.decide("status", { type: "ours" });
      await view.decide("owner", { type: "value", value: "not a person" });
      await view.save();
      expect(view.writes).toEqual([]);
      expect(view.state()?.write).toEqual({
        status: "refused",
        finding: { type: "unreadable", message: "invalid date" },
      });
      expect(view.state()?.decisions).toEqual({
        status: { type: "ours" },
        owner: { type: "value", value: "not a person" },
      });
      // A changed decision clears the reason and is written.
      refuse = false;
      await view.decide("owner", { type: "theirs" });
      expect(view.state()?.write).toEqual({ status: "idle" });
      await view.save();
      expect(view.writes.length).toBe(1);
      expect(view.writes[0]!.includes("owner: Анна Ли")).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  test("with nothing disputed the Page waits for «Принять»", async () => {
    const view = await harness({
      merge: {
        type: "merged",
        body: "Текст.\n",
        properties: [
          {
            key: "status",
            base: "a",
            ours: "a",
            theirs: "b",
            disputed: false,
            merged: "b",
          },
        ],
      },
      compose: (input) => ({
        type: "composed",
        content: "---\nstatus: b\n---\n" + (input.body as string),
      }),
    });
    try {
      view.editor.tf.insertText("!", { at: view.editor.api.end([]) });
      await view.save();
      expect(view.writes).toEqual([]);
      await view.accept();
      await view.save();
      expect(view.composes[0]!.decisions).toEqual({});
      expect(view.writes).toEqual(["---\nstatus: b\n---\nТекст.!\n"]);
    } finally {
      await view.cleanup();
    }
  });

  test("without a choice by properties the editor gets no text and writes nothing", async () => {
    const view = await harness({
      merge: { type: "unavailable", reason: { type: "missing_stage" } },
    });
    try {
      expect(view.text()).toBe("");
      expect(view.state()?.merge.type).toBe("unavailable");
      view.editor.tf.insertText("x");
      await view.save();
      expect(view.writes).toEqual([]);
      expect(view.composes).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });

  test("a frontmatter without marker lines opens as before", async () => {
    const view = await harness({
      file: "---\ntitle: Онбординг\n---\nТекст.\n",
    });
    try {
      expect(view.mergeReads).toEqual([]);
      expect(view.state()).toBe(null);
      expect(view.text()).toBe("Текст.");
    } finally {
      await view.cleanup();
    }
  });
}
