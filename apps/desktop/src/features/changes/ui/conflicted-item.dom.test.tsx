import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_CONFLICTED_ITEM_DOM !== "1") {
  test("Changes resolve a conflicted file by places or as a whole", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CONFLICTED_ITEM_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
  }, 20000);
} else {
  // The component shows the file it is given, one action slot per block of
  // markers of 7 characters, as `UnresolvedFile` reads them, and the line
  // annotations it is given; a plain file shows its text and annotations.
  type Annotation = { lineNumber: number; metadata: unknown };
  const annotationsOf = (
    lineAnnotations: Annotation[] | undefined,
    renderAnnotation: ((annotation: Annotation) => ReactNode) | undefined,
  ) =>
    (lineAnnotations ?? []).map((annotation) => (
      <div
        key={annotation.lineNumber}
        data-annotation-line={annotation.lineNumber}
      >
        {renderAnnotation?.(annotation)}
      </div>
    ));
  mock.module("@pierre/diffs/react", () => ({
    UnresolvedFile: ({
      file,
      lineAnnotations,
      renderAnnotation,
      renderMergeConflictUtility,
    }: {
      file: { contents: string };
      lineAnnotations?: (Annotation & { side: string })[];
      renderAnnotation?: (annotation: Annotation) => ReactNode;
      renderMergeConflictUtility: (
        action: { conflictIndex: number },
        getInstance: () => undefined,
      ) => ReactNode;
    }) => {
      const blocks = file.contents
        .split("\n")
        .filter((line) => line.startsWith("<<<<<<< ")).length;
      return (
        <div>
          <pre data-unresolved-file>{file.contents}</pre>
          {Array.from({ length: blocks }, (_, index) => (
            <div key={index}>
              {renderMergeConflictUtility(
                { conflictIndex: index },
                () => undefined,
              )}
            </div>
          ))}
          {annotationsOf(lineAnnotations, renderAnnotation)}
        </div>
      );
    },
    File: ({
      file,
      lineAnnotations,
      renderAnnotation,
    }: {
      file: { contents: string };
      lineAnnotations?: Annotation[];
      renderAnnotation?: (annotation: Annotation) => ReactNode;
    }) => (
      <div>
        <pre data-plain-file>{file.contents}</pre>
        {annotationsOf(lineAnnotations, renderAnnotation)}
      </div>
    ),
  }));

  const spacePath = "/project";
  const content = [
    "head",
    "<<<<<<<<<< ours",
    "one",
    "=======",
    "==========",
    "uno",
    ">>>>>>>>>> theirs",
    "middle",
    "<<<<<<<<<< ours",
    "two",
    "==========",
    "dos",
    ">>>>>>>>>> theirs",
    "",
  ].join("\n");
  const places = [
    {
      startLine: 1,
      endLine: 6,
      ours: "one\n=======",
      theirs: "uno",
      frontmatter: false,
    },
    {
      startLine: 8,
      endLine: 12,
      ours: "two",
      theirs: "dos",
      frontmatter: false,
    },
  ];

  function conflictFile(overrides: Record<string, unknown> = {}) {
    return {
      path: "data.yaml",
      kind: "text",
      version: "v1",
      content,
      places: { type: "places", places },
      ours: true,
      theirs: true,
      binary: false,
      changes: null,
      ...overrides,
    };
  }

  async function setup(
    file: Record<string, unknown>,
    resolve: (args: Record<string, unknown>) => unknown,
  ) {
    const dom = await createTestDom();
    const resolutions: Record<string, unknown>[] = [];
    mockNativeIpc(
      async (command, args) => {
        if (command === "git_conflict_file") return file;
        if (command === "git_resolve_conflict_file") {
          resolutions.push(args as Record<string, unknown>);
          return resolve(args as Record<string, unknown>);
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
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { ConflictedItem } = await import("./conflicted-item");
    const { ThemeProvider } = await import("@/components/ui/theme-provider");
    const m = await import("@/paraglide/messages.js");
    const settle = () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, 30));
      });
    const click = (element: Element | null) =>
      act(async () => {
        (element as HTMLElement).click();
        await new Promise((done) => setTimeout(done, 30));
      });
    const button = (text: string, root: ParentNode = dom.document) =>
      Array.from(root.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === text,
      ) ?? null;
    /** The actions of an open place of Svode, by its index. */
    const place = (index: number) =>
      dom.document.querySelector(`[data-conflict-place="${index}"]`);
    /** The mark of a place with a choice, by its index. */
    const accepted = (index: number) =>
      dom.document.querySelector(`[data-conflict-place-accepted="${index}"]`);
    return {
      dom,
      m,
      resolutions,
      settle,
      click,
      button,
      place,
      accepted,
      render: (kind = "text", path = "data.yaml") =>
        dom.render(
          <ThemeProvider theme="light" setTheme={() => {}}>
            <ConflictedItem
              spacePath={spacePath}
              path={path}
              kind={kind as never}
              onReveal={() => {}}
            />
          </ThemeProvider>,
        ),
      async dispose() {
        await dom.render(null);
        clearNativeMocks();
        await dom.dispose();
      },
    };
  }

  test("choices live in the window until every place has one, then apply at once", async () => {
    const t = await setup(conflictFile(), () => ({
      type: "conflict",
      files: ["other.txt"],
      kinds: [],
    }));
    try {
      await t.render();
      await t.settle();
      // The component gets Svode's places: the 7-character line inside the
      // first place is text, not a marker of its own.
      const shown = () =>
        t.dom.document.querySelector("[data-unresolved-file]")?.textContent;
      expect(shown()?.includes("​=======")).toBe(true);
      const slots = t.dom.document.querySelectorAll("[data-conflict-place]");
      expect(slots.length).toBe(2);
      expect(slots[0].getAttribute("role")).toBe("group");
      expect(slots[0].getAttribute("aria-label")).toBe(
        t.m.changes_conflict_place({ index: "1" }),
      );
      // One line of text actions in the slot of the place, no toggle.
      expect(
        Array.from(slots[0].querySelectorAll("button")).map(
          (button) => button.textContent,
        ),
      ).toEqual([
        t.m.changes_conflict_accept_ours(),
        t.m.changes_conflict_accept_theirs(),
        t.m.changes_conflict_accept_both(),
      ]);
      expect(
        t.dom.document.querySelector(
          "[data-slot=toggle-group], [role=radio], [aria-pressed]",
        ),
      ).toBe(null);
      await t.click(t.button(t.m.changes_conflict_accept_both(), slots[0]));
      expect(t.resolutions.length).toBe(0);
      // The place shows my side, then the incoming one, without markers,
      // marked with the side and «Изменить»; the second place stays open.
      expect(shown()).toBe(
        [
          "head",
          "one",
          "​=======",
          "uno",
          "middle",
          "<<<<<<< " + t.m.changes_conflict_ours(),
          "two",
          "=======",
          "dos",
          ">>>>>>> " + t.m.changes_conflict_theirs(),
          "",
        ].join("\n"),
      );
      expect(t.place(0)).toBe(null);
      expect(t.place(1) === null).toBe(false);
      const mark = t.accepted(0)!;
      expect(mark.getAttribute("data-conflict-accepted")).toBe("both");
      expect(
        mark.textContent?.includes(t.m.changes_conflict_accepted_both()),
      ).toBe(true);
      // The mark stands after the last line of the place: «uno», fourth.
      expect(
        mark
          .closest("[data-annotation-line]")
          ?.getAttribute("data-annotation-line"),
      ).toBe("4");
      // The view is rebuilt, and the keyboard stays at the place.
      const change = t.button(t.m.changes_conflict_change_choice(), mark);
      expect(t.dom.document.activeElement === change).toBe(true);
      // «Изменить» brings both sides and the actions back, nothing applied.
      await t.click(change);
      expect(t.accepted(0)).toBe(null);
      expect(
        t.dom.document.activeElement ===
          t.button(t.m.changes_conflict_accept_ours(), t.place(0)!),
      ).toBe(true);
      expect(
        t.dom.document.querySelectorAll("[data-conflict-place]").length,
      ).toBe(2);
      expect(
        shown()?.includes("<<<<<<< " + t.m.changes_conflict_ours() + "\none"),
      ).toBe(true);
      expect(t.resolutions.length).toBe(0);
      await t.click(t.button(t.m.changes_conflict_accept_both(), t.place(0)!));
      // «Взять входящее» fills the place left and applies both choices.
      await t.click(
        t.dom.document.querySelector("[data-conflict-remaining=theirs]"),
      );
      expect(t.resolutions).toEqual([
        {
          spacePath,
          path: "data.yaml",
          resolution: {
            type: "places",
            version: "v1",
            choices: ["both", "theirs"],
          },
        },
      ]);
    } finally {
      await t.dispose();
    }
  });

  test("the actions and marks of a place speak the language of the interface", async () => {
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const locale = getLocale();
    const t = await setup(conflictFile(), () => ({ type: "resolved" }));
    try {
      await setLocale("ru", { reload: false });
      await t.render();
      await t.settle();
      expect(
        Array.from(t.place(0)!.querySelectorAll("button")).map(
          (button) => button.textContent,
        ),
      ).toEqual(["Принять моё", "Принять входящее", "Принять оба"]);
      await t.click(t.button("Принять моё", t.place(0)!));
      expect(t.accepted(0)?.textContent).toBe("Принято: моё|Изменить");
      await t.click(t.button("Изменить", t.accepted(0)!));
      await t.click(t.button("Принять входящее", t.place(0)!));
      expect(t.accepted(0)?.textContent).toBe("Принято: входящее|Изменить");
      await setLocale("en", { reload: false });
      await t.render();
      await t.settle();
      expect(t.accepted(0)?.textContent).toBe("Accepted: incoming|Change");
      expect(
        Array.from(t.place(1)!.querySelectorAll("button")).map(
          (button) => button.textContent,
        ),
      ).toEqual(["Accept mine", "Accept incoming", "Accept both"]);
      await t.click(t.button("Accept both", t.place(1)!));
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "places",
        version: "v1",
        choices: ["theirs", "both"],
      });
    } finally {
      await setLocale(locale, { reload: false });
      await t.dispose();
    }
  });

  test("«Принять оба» is offered only at the places that allow it", async () => {
    const dom = await createTestDom();
    const { ConflictPlaces } = await import("./conflict-places");
    const { ThemeProvider } = await import("@/components/ui/theme-provider");
    const m = await import("@/paraglide/messages.js");
    try {
      await dom.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <ConflictPlaces
            path="data.yaml"
            version="v1"
            content={content}
            places={places}
            choices={[null, null]}
            disabled={false}
            allowsBoth={(place) => place !== 0}
            onChoose={() => {}}
            onReopen={() => {}}
          />
        </ThemeProvider>,
      );
      const labels = (index: number) =>
        Array.from(
          dom.document
            .querySelector(`[data-conflict-place="${index}"]`)!
            .querySelectorAll("button"),
        ).map((button) => button.textContent);
      expect(labels(0)).toEqual([
        m.changes_conflict_accept_ours(),
        m.changes_conflict_accept_theirs(),
      ]);
      expect(labels(1)).toEqual([
        m.changes_conflict_accept_ours(),
        m.changes_conflict_accept_theirs(),
        m.changes_conflict_accept_both(),
      ]);
    } finally {
      await dom.render(null);
      await dom.dispose();
    }
  });

  test("a result that does not read shows the error at the file, keeps the choices shown and a changed choice applies again", async () => {
    let refuse = true;
    const t = await setup(conflictFile(), () =>
      refuse
        ? {
            type: "unresolved",
            path: "data.yaml",
            finding: { type: "unreadable", message: "duplicate key" },
          }
        : { type: "resolved" },
    );
    try {
      await t.render();
      await t.settle();
      await t.click(
        t.dom.document.querySelector("[data-conflict-remaining=ours]"),
      );
      const alert = t.dom.document.querySelector(
        "[data-conflict-problem=unreadable]",
      )!;
      expect(
        alert.textContent?.includes(t.m.changes_conflict_unreadable_title()),
      ).toBe(true);
      expect(
        alert.textContent?.includes(
          t.m.changes_conflict_unreadable({ message: "duplicate key" }),
        ),
      ).toBe(true);
      // Every place shows its choice: the file as it was applied.
      expect(t.dom.document.querySelector("[data-unresolved-file]")).toBe(null);
      expect(
        t.dom.document.querySelector("[data-plain-file]")?.textContent,
      ).toBe("head\none\n\u200b=======\nmiddle\ntwo\n");
      expect(t.accepted(0)?.getAttribute("data-conflict-accepted")).toBe(
        "ours",
      );
      expect(t.accepted(1)?.getAttribute("data-conflict-accepted")).toBe(
        "ours",
      );
      expect(t.dom.document.querySelector("[data-conflict-place]")).toBe(null);
      refuse = false;
      await t.click(
        t.button(t.m.changes_conflict_change_choice(), t.accepted(1)!),
      );
      expect(t.resolutions.length).toBe(1);
      expect(t.accepted(0) === null).toBe(false);
      await t.click(
        t.button(t.m.changes_conflict_accept_theirs(), t.place(1)!),
      );
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "places",
        version: "v1",
        choices: ["ours", "theirs"],
      });
      expect(t.dom.document.querySelector("[data-conflict-problem]")).toBe(
        null,
      );
    } finally {
      await t.dispose();
    }
  });

  test("a file without clear places warns and takes a side for the whole file after confirmation", async () => {
    const t = await setup(
      conflictFile({
        places: { type: "unclear", reason: "ambiguous" },
        theirs: false,
      }),
      () => ({ type: "resolved" }),
    );
    try {
      await t.render();
      await t.settle();
      const alert = t.dom.document.querySelector(
        "[data-conflict-unclear=ambiguous]",
      )!;
      expect(
        alert.textContent?.includes(t.m.changes_conflict_unclear_ambiguous()),
      ).toBe(true);
      expect(t.dom.document.querySelector("[data-conflict-place]")).toBe(null);
      // The incoming side has no version in the index.
      const theirs = t.dom.document.querySelector<HTMLButtonElement>(
        "[data-conflict-whole=theirs]",
      )!;
      expect(theirs.disabled).toBe(true);
      await t.click(t.dom.document.querySelector("[data-conflict-whole=ours]"));
      expect(t.resolutions.length).toBe(0);
      const dialog = t.dom.document.querySelector("[role=alertdialog]")!;
      expect(
        dialog.textContent?.includes(
          t.m.changes_conflict_keep_ours_description(),
        ),
      ).toBe(true);
      await t.click(t.button(t.m.changes_conflict_keep_ours(), dialog));
      expect(t.resolutions).toEqual([
        {
          spacePath,
          path: "data.yaml",
          resolution: { type: "side", side: "ours" },
        },
      ]);
    } finally {
      await t.dispose();
    }
  });

  /** A Page with a place in its properties and one in its text. */
  const page = conflictFile({
    path: "notes/page.md",
    kind: "page_properties",
    content: [
      "---",
      "<<<<<<< ours",
      "title: Mine",
      "=======",
      "title: Yours",
      ">>>>>>> theirs",
      "---",
      "Text",
      "<<<<<<< ours",
      "one",
      "=======",
      "uno",
      ">>>>>>> theirs",
      "",
    ].join("\n"),
    places: {
      type: "places",
      places: [
        {
          startLine: 1,
          endLine: 5,
          ours: "title: Mine",
          theirs: "title: Yours",
          frontmatter: true,
        },
        {
          startLine: 8,
          endLine: 12,
          ours: "one",
          theirs: "uno",
          frontmatter: false,
        },
      ],
    },
  });

  test("a conflicted Page is chosen by places without «Принять оба» in its frontmatter and leads to its editor", async () => {
    const t = await setup(page, () => ({ type: "resolved" }));
    const { registerConflictNavigation } =
      await import("@/features/git/app-shell");
    const pages: unknown[] = [];
    const unregister = registerConflictNavigation({
      openFile: () => {},
      openPage: (target) => pages.push(target),
    });
    try {
      for (const kind of ["page_text", "page_properties"]) {
        await t.render(kind, "notes/page.md");
        await t.settle();
        const labels = (index: number) =>
          Array.from(t.place(index)!.querySelectorAll("button")).map(
            (button) => button.textContent,
          );
        expect(labels(0)).toEqual([
          t.m.changes_conflict_accept_ours(),
          t.m.changes_conflict_accept_theirs(),
        ]);
        expect(labels(1)).toEqual([
          t.m.changes_conflict_accept_ours(),
          t.m.changes_conflict_accept_theirs(),
          t.m.changes_conflict_accept_both(),
        ]);
      }
      // «Открыть в редакторе» stands in the line above the file.
      const line = t.dom.document.querySelector(
        "[data-conflict-remaining=ours]",
      )!.parentElement!;
      const open = line.querySelector("[data-conflict-open-editor]");
      expect(open?.textContent).toBe(t.m.changes_conflict_open_editor());
      await t.click(open);
      expect(pages).toEqual([{ spacePath, path: "notes/page.md" }]);
      await t.click(
        t.button(t.m.changes_conflict_accept_theirs(), t.place(0)!),
      );
      await t.click(t.button(t.m.changes_conflict_accept_both(), t.place(1)!));
      expect(t.resolutions).toEqual([
        {
          spacePath,
          path: "notes/page.md",
          resolution: {
            type: "places",
            version: "v1",
            choices: ["theirs", "both"],
          },
        },
      ]);
    } finally {
      unregister();
      await t.dispose();
    }
  });

  test("a Page without clear places warns, takes a side for the whole file and leads to its editor", async () => {
    const t = await setup(
      { ...page, places: { type: "unclear", reason: "ambiguous" } },
      () => ({ type: "resolved" }),
    );
    const { registerConflictNavigation } =
      await import("@/features/git/app-shell");
    const unregister = registerConflictNavigation({
      openFile: () => {},
      openPage: () => {},
    });
    try {
      await t.render("page_text", "notes/page.md");
      await t.settle();
      expect(
        t.dom.document.querySelector("[data-conflict-unclear=ambiguous]") ===
          null,
      ).toBe(false);
      expect(t.dom.document.querySelector("[data-conflict-place]")).toBe(null);
      const ours = t.dom.document.querySelector("[data-conflict-whole=ours]")!;
      expect(
        ours.parentElement?.querySelector("[data-conflict-open-editor]") ==
          null,
      ).toBe(false);
      await t.click(ours);
      await t.click(
        t.button(
          t.m.changes_conflict_keep_ours(),
          t.dom.document.querySelector("[role=alertdialog]")!,
        ),
      );
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "ours",
      });
    } finally {
      unregister();
      await t.dispose();
    }
  });

  test("a project and a Space config are chosen by places and a repeated key does not resolve them", async () => {
    for (const path of [".svode/config.json", "docs/.svode/config.json"]) {
      let refuse = true;
      const t = await setup(conflictFile({ path }), () =>
        refuse
          ? {
              type: "unresolved",
              path,
              finding: {
                type: "unreadable",
                message: "Svode cannot read the field `name`",
              },
            }
          : { type: "resolved" },
      );
      try {
        await t.render("text", path);
        await t.settle();
        expect(
          t.dom.document.body.textContent?.includes(
            t.m.changes_conflict_in_git(),
          ),
        ).toBe(false);
        expect(
          t.dom.document.querySelectorAll("[data-conflict-place]").length,
        ).toBe(2);
        await t.click(
          t.button(t.m.changes_conflict_accept_both(), t.place(0)!),
        );
        await t.click(
          t.button(t.m.changes_conflict_accept_ours(), t.place(1)!),
        );
        expect(t.resolutions).toEqual([
          {
            spacePath,
            path,
            resolution: {
              type: "places",
              version: "v1",
              choices: ["both", "ours"],
            },
          },
        ]);
        expect(
          t.dom.document
            .querySelector("[data-conflict-problem=unreadable]")
            ?.textContent?.includes(
              t.m.changes_conflict_unreadable({
                message: "Svode cannot read the field `name`",
              }),
            ),
        ).toBe(true);
        refuse = false;
        await t.click(
          t.button(t.m.changes_conflict_change_choice(), t.accepted(0)!),
        );
        await t.click(
          t.button(t.m.changes_conflict_accept_theirs(), t.place(0)!),
        );
        expect(t.resolutions.at(-1)?.resolution).toEqual({
          type: "places",
          version: "v1",
          choices: ["theirs", "ours"],
        });
        expect(t.dom.document.querySelector("[data-conflict-problem]")).toBe(
          null,
        );
      } finally {
        await t.dispose();
      }
    }
  });

  test("a Space pointer is left to Git until its actions", async () => {
    const t = await setup(conflictFile(), () => ({ type: "resolved" }));
    try {
      await t.render("space_pointer", "space");
      await t.settle();
      expect(
        t.dom.document.body.textContent?.includes(
          t.m.changes_conflict_in_git(),
        ),
      ).toBe(true);
      expect(t.dom.document.querySelector("[data-conflict-place]")).toBe(null);
    } finally {
      await t.dispose();
    }
  });

  /** A conflicted file without markers of `kind`. */
  function wholeFile(
    kind: string,
    changes: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return conflictFile({
      kind,
      content: null,
      places: null,
      binary: kind === "binary",
      changes,
      ...overrides,
    });
  }

  const side = (
    change: string,
    extra: { path?: string; size?: number } = {},
  ) => ({ change, path: extra.path ?? null, size: extra.size ?? null });

  const action = (t: { dom: { document: Document } }, name: string) =>
    t.dom.document.querySelector(`[data-conflict-action=${name}]`);

  test("a binary file names what each side did and asks before taking the incoming version", async () => {
    const t = await setup(
      wholeFile("binary", {
        ours: side("modified", { size: 2048 }),
        theirs: side("modified", { size: 512 }),
      }),
      () => ({ type: "conflict", files: ["other.txt"], kinds: [] }),
    );
    try {
      await t.render("binary", "image.png");
      await t.settle();
      expect(
        t.dom.document.querySelector("[data-conflict-sides]")?.textContent,
      ).toBe(
        t.m.changes_conflict_sides({
          ours: t.m.changes_conflict_side_size({
            change: t.m.changes_conflict_ours_modified(),
            size: "2 KB",
          }),
          theirs: t.m.changes_conflict_side_size({
            change: t.m.changes_conflict_theirs_modified(),
            size: "512 B",
          }),
        }),
      );
      expect(
        t.dom.document.body.textContent?.includes(
          t.m.changes_conflict_in_git(),
        ),
      ).toBe(false);
      // «Оставить моё» keeps my version without asking.
      await t.click(action(t, "keep_ours"));
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "ours",
      });
      // «Взять входящее» discards my version: it asks and names the loss.
      await t.click(action(t, "take_theirs"));
      expect(t.resolutions.length).toBe(1);
      const dialog = t.dom.document.querySelector("[role=alertdialog]")!;
      expect(
        dialog.textContent?.includes(
          t.m.changes_conflict_take_theirs_whole_description(),
        ),
      ).toBe(true);
      await t.click(t.button(t.m.changes_conflict_take_theirs(), dialog));
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "theirs",
      });
      await t.click(action(t, "keep_both"));
      expect(t.resolutions.at(-1)?.resolution).toEqual({ type: "keepBoth" });
    } finally {
      await t.dispose();
    }
  });

  test("an unavailable LFS object leaves the file with the reason", async () => {
    const t = await setup(
      wholeFile("binary", {
        ours: side("modified", { size: 2000 }),
        theirs: side("modified", { size: 3000 }),
      }),
      () => ({
        type: "unresolved",
        path: "video.bin",
        finding: { type: "lfs_object", message: "smudge filter lfs failed" },
      }),
    );
    try {
      await t.render("binary", "video.bin");
      await t.settle();
      await t.click(action(t, "keep_both"));
      const alert = t.dom.document.querySelector(
        "[data-conflict-problem=lfs_object]",
      )!;
      expect(
        alert.textContent?.includes(t.m.changes_conflict_lfs_object_title()),
      ).toBe(true);
      expect(
        alert.textContent?.includes(
          t.m.changes_conflict_lfs_object({
            message: "smudge filter lfs failed",
          }),
        ),
      ).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  test("deleting my edited file asks first, deleting a file I deleted does not", async () => {
    const edited = await setup(
      wholeFile(
        "modify_delete",
        { ours: side("modified"), theirs: side("deleted") },
        { theirs: false },
      ),
      () => ({ type: "resolved" }),
    );
    try {
      await edited.render("modify_delete", "notes.txt");
      await edited.settle();
      expect(
        edited.dom.document.querySelector("[data-conflict-sides]")?.textContent,
      ).toBe(
        edited.m.changes_conflict_sides({
          ours: edited.m.changes_conflict_ours_modified(),
          theirs: edited.m.changes_conflict_theirs_deleted(),
        }),
      );
      await edited.click(action(edited, "delete"));
      expect(edited.resolutions.length).toBe(0);
      const dialog = edited.dom.document.querySelector("[role=alertdialog]")!;
      expect(
        dialog.textContent?.includes(
          edited.m.changes_conflict_delete_description(),
        ),
      ).toBe(true);
      await edited.click(
        edited.button(edited.m.changes_conflict_delete(), dialog),
      );
      expect(edited.resolutions.at(-1)?.resolution).toEqual({
        type: "delete",
      });
      // «Оставить с правками» keeps the side with the file.
      await edited.click(action(edited, "keep_edited"));
      expect(edited.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "ours",
      });
    } finally {
      await edited.dispose();
    }
    const deleted = await setup(
      wholeFile(
        "modify_delete",
        { ours: side("deleted"), theirs: side("modified") },
        { ours: false },
      ),
      () => ({ type: "resolved" }),
    );
    try {
      await deleted.render("modify_delete", "notes.txt");
      await deleted.settle();
      await deleted.click(action(deleted, "delete"));
      expect(deleted.dom.document.querySelector("[role=alertdialog]")).toBe(
        null,
      );
      expect(deleted.resolutions.at(-1)?.resolution).toEqual({
        type: "delete",
      });
      await deleted.click(action(deleted, "keep_edited"));
      expect(deleted.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "theirs",
      });
    } finally {
      await deleted.dispose();
    }
  });

  test("keeping my edits against a deletion sends my side at once and holds the actions only while it runs", async () => {
    const { useGitStore } = await import("@/features/git");
    const answers: {
      settle: (value: unknown) => void;
      fail: (error: Error) => void;
    }[] = [];
    const t = await setup(
      wholeFile(
        "modify_delete",
        { ours: side("modified"), theirs: side("deleted") },
        { theirs: false },
      ),
      () => new Promise((settle, fail) => answers.push({ settle, fail })),
    );
    const held = () =>
      ["keep_edited", "delete"].map(
        (name) => (action(t, name) as HTMLButtonElement).disabled,
      );
    try {
      await t.render("modify_delete", "mdel.md");
      await t.settle();
      expect(held()).toEqual([false, false]);
      // «Оставить с правками» does not ask: my version stays.
      await t.click(action(t, "keep_edited"));
      expect(t.dom.document.querySelector("[role=alertdialog]")).toBe(null);
      expect(t.resolutions).toEqual([
        {
          spacePath,
          path: "mdel.md",
          resolution: { type: "side", side: "ours" },
        },
      ]);
      // While it runs, its actions and the sync of the Space are taken.
      expect(held()).toEqual([true, true]);
      expect(useGitStore.getState().syncing[spacePath]).toBe(true);
      await act(async () => {
        answers[0].settle({ type: "resolved" });
        await new Promise((done) => setTimeout(done, 30));
      });
      expect(held()).toEqual([false, false]);
      expect(!!useGitStore.getState().syncing[spacePath]).toBe(false);
      expect(t.dom.document.querySelector("[data-conflict-problem]")).toBe(
        null,
      );
      // A refusal gives them back as well and names its reason.
      await t.click(action(t, "keep_edited"));
      expect(held()).toEqual([true, true]);
      await act(async () => {
        answers[1].fail(new Error("Too many open files"));
        await new Promise((done) => setTimeout(done, 30));
      });
      expect(held()).toEqual([false, false]);
      expect(!!useGitStore.getState().syncing[spacePath]).toBe(false);
      const alert = t.dom.document.querySelector(
        "[data-conflict-problem=failed]",
      )!;
      expect(alert.textContent?.includes(t.m.changes_conflict_failed())).toBe(
        true,
      );
      expect(alert.textContent?.includes("Too many open files")).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  test("taking the incoming name asks first and names both names", async () => {
    const t = await setup(
      wholeFile(
        "rename_rename",
        {
          ours: side("renamed", { path: "notes-ours.txt" }),
          theirs: side("renamed", { path: "notes-theirs.txt" }),
        },
        { theirs: false },
      ),
      () => ({ type: "resolved" }),
    );
    try {
      await t.render("rename_rename", "notes-ours.txt");
      await t.settle();
      expect(
        t.dom.document.querySelector("[data-conflict-sides]")?.textContent,
      ).toBe(
        t.m.changes_conflict_sides({
          ours: t.m.changes_conflict_ours_renamed({ name: "notes-ours.txt" }),
          theirs: t.m.changes_conflict_theirs_renamed({
            name: "notes-theirs.txt",
          }),
        }),
      );
      await t.click(action(t, "keep_my_name"));
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "ours",
      });
      await t.click(action(t, "take_incoming_name"));
      expect(t.resolutions.length).toBe(1);
      const dialog = t.dom.document.querySelector("[role=alertdialog]")!;
      expect(
        dialog.textContent?.includes(
          t.m.changes_conflict_take_incoming_name_description({
            ours: "notes-ours.txt",
            theirs: "notes-theirs.txt",
          }),
        ),
      ).toBe(true);
      await t.click(
        t.button(t.m.changes_conflict_take_incoming_name(), dialog),
      );
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "theirs",
      });
    } finally {
      await t.dispose();
    }
  });

  test("a rename against a deletion keeps the new name or deletes it", async () => {
    const t = await setup(
      wholeFile(
        "rename_delete",
        {
          ours: side("deleted"),
          theirs: side("renamed", { path: "moved.txt" }),
        },
        { ours: false },
      ),
      () => ({ type: "resolved" }),
    );
    try {
      await t.render("rename_delete", "moved.txt");
      await t.settle();
      await t.click(action(t, "keep_new_name"));
      expect(t.resolutions.at(-1)?.resolution).toEqual({
        type: "side",
        side: "theirs",
      });
      // My side deleted the file: the deletion discards nothing of mine.
      await t.click(action(t, "delete"));
      expect(t.dom.document.querySelector("[role=alertdialog]")).toBe(null);
      expect(t.resolutions.at(-1)?.resolution).toEqual({ type: "delete" });
    } finally {
      await t.dispose();
    }
  });

  test("a file both sides added keeps both versions", async () => {
    const t = await setup(conflictFile({ kind: "add_add" }), () => ({
      type: "resolved",
    }));
    try {
      await t.render("add_add", "data.yaml");
      await t.settle();
      // A text file of its kind: places and «Сохранить обе».
      expect(
        t.dom.document.querySelectorAll("[data-conflict-place]").length,
      ).toBe(2);
      await t.click(action(t, "keep_both"));
      expect(t.resolutions.at(-1)?.resolution).toEqual({ type: "keepBoth" });
      // A Page both sides added: its places and «Сохранить обе», as here.
      await t.render("add_add", "notes/page.md");
      await t.settle();
      expect(
        t.dom.document.querySelectorAll("[data-conflict-place]").length,
      ).toBe(2);
      await t.click(action(t, "keep_both"));
      expect(t.resolutions.at(-1)).toEqual({
        spacePath,
        path: "notes/page.md",
        resolution: { type: "keepBoth" },
      });
    } finally {
      await t.dispose();
    }
  });

  test("the header of a conflicted file names its kind", async () => {
    const dom = await createTestDom();
    const { ChangedItemHeader } = await import("./changed-item-header");
    const { Accordion, AccordionItem } =
      await import("@/components/ui/accordion");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    try {
      await dom.render(
        <TooltipProvider>
          <Accordion type="multiple">
            <AccordionItem value="data.yaml">
              <ChangedItemHeader
                path="data.yaml"
                name="data.yaml"
                state="conflict"
                stats={{ path: "data.yaml", additions: null, deletions: null }}
                conflictKind="text"
              />
            </AccordionItem>
          </Accordion>
        </TooltipProvider>,
      );
      const badge = dom.document.querySelector(
        "[data-changes-conflict-kind=text]",
      )!;
      expect(badge.textContent).toBe(m.git_conflict_kind_text());
    } finally {
      await dom.render(null);
      await dom.dispose();
    }
  });
}
