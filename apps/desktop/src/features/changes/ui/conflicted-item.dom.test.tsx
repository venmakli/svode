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
  // The component shows the file it is given and one action slot per block
  // of markers of 7 characters, as `UnresolvedFile` reads them.
  mock.module("@pierre/diffs/react", () => ({
    UnresolvedFile: ({
      file,
      renderMergeConflictUtility,
    }: {
      file: { contents: string };
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
        </div>
      );
    },
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
    { startLine: 1, endLine: 6, ours: "one\n=======", theirs: "uno" },
    { startLine: 8, endLine: 12, ours: "two", theirs: "dos" },
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
    return {
      dom,
      m,
      resolutions,
      settle,
      click,
      button,
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
      const shown = t.dom.document.querySelector("[data-unresolved-file]")!;
      expect(shown.textContent?.includes("​=======")).toBe(true);
      const slots = t.dom.document.querySelectorAll("[data-conflict-place]");
      expect(slots.length).toBe(2);
      expect(slots[0].getAttribute("aria-label")).toBe(
        t.m.changes_conflict_place({ index: "1" }),
      );
      await t.click(t.button(t.m.changes_conflict_both(), slots[0]));
      expect(t.resolutions.length).toBe(0);
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

  test("a result that does not read shows the error at the file and a changed choice applies again", async () => {
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
      refuse = false;
      const slots = t.dom.document.querySelectorAll("[data-conflict-place]");
      await t.click(t.button(t.m.changes_conflict_theirs(), slots[1]));
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

  test("a conflicted Page leads to its editor", async () => {
    const t = await setup(conflictFile(), () => ({ type: "resolved" }));
    const { registerConflictNavigation } =
      await import("@/features/git/app-shell");
    const pages: unknown[] = [];
    const unregister = registerConflictNavigation({
      openFile: () => {},
      openPage: (target) => pages.push(target),
    });
    try {
      await t.render("page_properties", "notes/page.md");
      await t.settle();
      expect(
        t.dom.document.body.textContent?.includes(t.m.changes_conflict_page()),
      ).toBe(true);
      await t.click(
        t.dom.document.querySelector("[data-conflict-open-editor]"),
      );
      expect(pages).toEqual([{ spacePath, path: "notes/page.md" }]);
    } finally {
      unregister();
      await t.dispose();
    }
  });

  test("a project config and files of other kinds are left to Git until their actions", async () => {
    const t = await setup(conflictFile(), () => ({ type: "resolved" }));
    try {
      await t.render("text", ".svode/config.json");
      await t.settle();
      expect(
        t.dom.document.body.textContent?.includes(
          t.m.changes_conflict_in_git(),
        ),
      ).toBe(true);
      expect(t.dom.document.querySelector("[data-conflict-place]")).toBe(null);
      await t.render("binary", "image.png");
      await t.settle();
      expect(
        t.dom.document.body.textContent?.includes(
          t.m.changes_conflict_in_git(),
        ),
      ).toBe(true);
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
