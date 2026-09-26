import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_CHANGES_DOM !== "1") {
  test("Changes DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout", "20000", fileURLToPath(import.meta.url)],
      { env: { ...process.env, SVODE_CHANGES_DOM: "1" }, encoding: "utf8" },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
  });
} else {
  test("inspection is passive and save shortcuts retain their origin", async () => {
    const dom = createDom();
    const restore = installDomGlobals(dom);
    const calls: string[] = [];
    let dirty = true;
    let accessStatus = "local";
    let failSave = true;
    const status = () => ({
      branch: "main",
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: dirty,
      hasConflicts: false,
      tracking: null,
      files: dirty ? [{ path: "contract/note.md", state: "modified" }] : [],
    });
    mockNativeIpc(
      (command, args) => {
        calls.push(command);
        if (command === "git_status") return status();
        if (command === "repository_access_get")
          return {
            status: accessStatus,
            repositoryId: "repo",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_working_tree_item")
          return {
            ...(args as object),
            state: "no_content_diff",
            before: "same",
            after: "same",
          };
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { ChangesControl } = await import("./changes-control");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { Sheet, SheetContent, SheetTitle } =
      await import("@/components/ui/sheet");
    const { registerPageSaveOwner } = await import("@/features/git/editor");
    const { refreshGitStatus } = await import("@/features/git");
    let saved = 0;
    let savedAll = 0;
    let peekCloses = 0;
    const release = registerPageSaveOwner("/project", "contract/note.md", {
      save: async () => {
        saved++;
        if (failSave) throw new Error("Synthetic save failure");
        dirty = false;
        await refreshGitStatus("/project");
      },
      saveAll: async () => {
        savedAll++;
      },
    });
    const root = createRoot(dom.window.document.getElementById("app")!);
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <Sheet
              open
              onOpenChange={(open) => {
                if (!open) peekCloses++;
              }}
            >
              <SheetContent aria-describedby={undefined}>
                <SheetTitle>Page Peek</SheetTitle>
                <div
                  id="origin-draft"
                  contentEditable
                  suppressContentEditableWarning
                >
                  preserved draft
                </div>
                <ChangesControl
                  origin="peek"
                  target={{
                    kind: "page",
                    sourceShape: "file",
                    spacePath: "/project",
                    path: "contract/note.md",
                    name: "Note",
                  }}
                />
              </SheetContent>
            </Sheet>
          </TooltipProvider>,
        );
        await nextFrame(dom);
      });
      const trigger = dom.window.document.querySelector<HTMLButtonElement>(
        "[data-changes-trigger]",
      )!;
      expect(Boolean(trigger)).toBe(true);
      await act(async () => {
        trigger.click();
        await nextFrame(dom);
      });
      expect(calls.includes("git_working_tree_item")).toBe(true);
      expect(
        dom.window.document.querySelectorAll('[role="dialog"]').length,
      ).toBe(2);
      expect(calls.some((name) => /write|commit|verify/.test(name))).toBe(
        false,
      );
      expect(
        Boolean(dom.window.document.querySelector("[data-changes-body]")),
      ).toBe(true);
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(savedAll).toBe(1);
      expect(saved).toBe(0);
      const save = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-slot="sheet-footer"] button',
      )!;
      expect(save.disabled).toBe(false);
      await act(async () => {
        save.click();
        await nextFrame(dom);
      });
      expect(saved).toBe(1);
      expect(
        Boolean(
          dom.window.document.querySelector('[data-slot="sheet-footer"]'),
        ),
      ).toBe(true);
      accessStatus = "unknown";
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await nextFrame(dom);
      });
      expect(
        dom.window.document.querySelector<HTMLButtonElement>(
          '[data-slot="sheet-footer"] button',
        )!.disabled,
      ).toBe(true);
      expect(
        Boolean(dom.window.document.querySelector("[data-changes-body]")),
      ).toBe(true);
      accessStatus = "local";
      failSave = false;
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await nextFrame(dom);
      });
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            bubbles: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(saved).toBe(2);
      expect(
        Boolean(dom.window.document.querySelector("[data-changes-body]")),
      ).toBe(true);
      expect(
        dom.window.document.querySelector('[data-slot="sheet-footer"]'),
      ).toBeNull();
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(peekCloses).toBe(0);
      expect(
        dom.window.document.querySelectorAll('[role="dialog"]').length,
      ).toBe(1);
      expect(
        dom.window.document.querySelector<HTMLElement>("#origin-draft")!
          .textContent,
      ).toBe("preserved draft");
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      release();
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });
  test("aggregate Peek loads only expanded rows and preserves surviving focus, scope and save intent", async () => {
    const dom = createDom();
    const restore = installDomGlobals(dom);
    await import("./text-diff");
    const reads: string[] = [];
    const statistics: string[][] = [];
    const base = {
      branch: "main",
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: true,
      hasConflicts: false,
      tracking: null,
    };
    let files = [
      "contract/README.md",
      "contract/manual.pdf",
      "contract/broken.md",
      "contract/image.png",
      "outside.md",
    ].map((path) => ({
      path,
      state: path.endsWith("manual.pdf")
        ? ("deleted" as const)
        : path.endsWith("image.png")
          ? ("untracked" as const)
          : ("modified" as const),
    }));
    let repositoryError = false;
    let itemError = true;
    mockNativeIpc(
      (command, args) => {
        if (command === "git_status") {
          if (repositoryError)
            throw new Error("Synthetic repository unavailable");
          return { ...base, files };
        }
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "aggregate-repo",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_inspection_stats") {
          const input = args as { paths: string[]; generation: string };
          statistics.push(input.paths);
          return {
            generation: input.generation,
            items: input.paths.map((path) => ({
              path,
              additions: path.endsWith("pdf") ? null : 2,
              deletions: path.endsWith("pdf") ? null : 1,
            })),
          };
        }
        if (command === "git_working_tree_item") {
          const input = args as {
            path: string;
            scope: { kind: string; path: string };
          };
          reads.push(input.path);
          expect({ kind: input.scope.kind, path: input.scope.path }).toEqual({
            kind: "directory",
            path: "contract",
          });
          if (input.path.endsWith("broken.md") && itemError)
            throw new Error("Synthetic patch failure");
          return {
            ...input,
            generation: (args as { generation: string }).generation,
            state: input.path.endsWith("pdf")
              ? "binary"
              : input.path.endsWith("README.md")
                ? "text"
                : "no_content_diff",
            before: input.path.endsWith("README.md") ? "Before\n" : null,
            after: input.path.endsWith("README.md") ? "After\nAdded\n" : null,
            beforeBytes: 10,
            afterBytes: 20,
          };
        }
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { ChangesControl } = await import("./changes-control");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { registerPageSaveOwner } = await import("@/features/git/editor");
    const { refreshGitStatus } = await import("@/features/git");
    const scopes: unknown[] = [];
    const { ThemeProvider } = await import("@/components/ui/theme-provider");
    let saveCurrent = 0;
    let failSave = true;
    const release = registerPageSaveOwner("/aggregate", "contract/README.md", {
      save: async () => {
        saveCurrent++;
      },
      saveAll: async (scope) => {
        scopes.push(scope);
        if (failSave) throw new Error("Synthetic scoped failure");
        files = files.filter((file) => !file.path.startsWith("contract/"));
        await refreshGitStatus("/aggregate");
      },
    });
    const root = createRoot(dom.window.document.getElementById("app")!);
    const doc = dom.window.document;
    const triggers = () => [
      ...doc.querySelectorAll<HTMLButtonElement>("[data-changes-item-trigger]"),
    ];
    const trigger = (path: string) =>
      triggers().find((node) => node.dataset.changesItemTrigger === path)!;
    const counts = (path: string) =>
      trigger(path).querySelector("[data-changes-stats]")?.textContent;
    const renderWithTheme = (theme: "dark" | "light" | "system") =>
      root.render(
        <ThemeProvider theme={theme} setTheme={() => {}}>
          <TooltipProvider>
            <ChangesControl
              origin="peek"
              target={{
                kind: "page",
                sourceShape: "directory",
                spacePath: "/aggregate",
                path: "contract/README.md",
                name: "Contract",
              }}
            />
          </TooltipProvider>
        </ThemeProvider>,
      );
    try {
      await act(async () => {
        renderWithTheme("dark");
        await nextFrame(dom);
      });
      await act(async () => {
        doc.querySelector<HTMLButtonElement>("[data-changes-trigger]")!.click();
        await nextFrame(dom);
      });
      expect(triggers().length).toBe(4);
      expect(reads).toEqual([]);
      expect(statistics).toEqual([
        [
          "contract/README.md",
          "contract/manual.pdf",
          "contract/broken.md",
          "contract/image.png",
        ],
      ]);
      expect(counts("contract/README.md")).toBe("−1+2");
      expect(doc.querySelector("[data-changes-summary]")?.textContent).toBe(
        "−3+6*",
      );
      expect(trigger("contract/manual.pdf").hasAttribute("title")).toBe(false);
      assert.ok(doc.querySelector('[data-slot="accordion"]'));
      expect(doc.querySelector("diffs-container")).toBeNull();
      expect(
        triggers().every(
          (node) => node.getAttribute("aria-expanded") === "false",
        ),
      ).toBe(true);
      await act(async () => {
        trigger("contract/README.md").click();
        await nextFrame(dom);
      });
      await act(async () => {
        trigger("contract/manual.pdf").click();
        await nextFrame(dom);
      });
      expect(reads).toEqual(["contract/README.md", "contract/manual.pdf"]);
      expect(counts("contract/README.md")).toBe("−1+2");
      assert.ok(
        doc
          .querySelector(
            '[data-changes-item="contract/README.md"] diffs-container',
          )
          ?.shadowRoot?.querySelector("pre"),
      );
      const diffContainer = doc.querySelector(
        '[data-changes-item="contract/README.md"] diffs-container',
      )!;
      const themeStyles = () =>
        [...diffContainer.shadowRoot!.querySelectorAll("style")].find((node) =>
          node.textContent?.includes("@layer rendered"),
        )?.textContent ?? "";
      expect(themeStyles().includes("color-scheme: dark;")).toBe(true);
      for (const theme of ["light", "dark", "system", "dark"] as const) {
        await act(async () => {
          renderWithTheme(theme);
          await nextFrame(dom);
        });
        expect(
          doc.querySelector(
            '[data-changes-item="contract/README.md"] diffs-container',
          ),
        ).toBe(diffContainer);
        expect(
          theme === "system"
            ? !themeStyles().includes("color-scheme:")
            : themeStyles().includes(`color-scheme: ${theme};`),
        ).toBe(true);
      }
      expect(reads).toEqual(["contract/README.md", "contract/manual.pdf"]);
      expect(
        triggers().filter(
          (node) => node.getAttribute("aria-expanded") === "true",
        ).length,
      ).toBe(2);
      await act(async () => {
        trigger("contract/README.md").click();
        await nextFrame(dom);
      });
      expect(trigger("contract/README.md").getAttribute("aria-expanded")).toBe(
        "false",
      );
      expect(
        doc.querySelector(
          '[data-changes-item="contract/README.md"] > div diffs-container',
        ),
      ).toBeNull();
      expect(trigger("contract/manual.pdf").getAttribute("aria-expanded")).toBe(
        "true",
      );
      expect(reads.length).toBe(2);
      expect(counts("contract/README.md")).toBe("−1+2");
      await selectChangeFilter(dom, "Modified");
      expect(triggers().map((node) => node.dataset.changesItemTrigger)).toEqual(
        ["contract/README.md", "contract/broken.md"],
      );
      expect(doc.querySelector("[data-changes-summary]")?.textContent).toBe(
        "−2+4",
      );
      expect(statistics.length).toBe(1);
      await selectChangeFilter(dom, "All files");
      expect(trigger("contract/manual.pdf").getAttribute("aria-expanded")).toBe(
        "true",
      );
      expect(statistics.length).toBe(1);
      await act(async () => {
        trigger("contract/README.md").click();
        await nextFrame(dom);
      });
      expect(reads).toEqual([
        "contract/README.md",
        "contract/manual.pdf",
        "contract/manual.pdf",
        "contract/README.md",
      ]);
      await act(async () => {
        trigger("contract/broken.md").click();
        await nextFrame(dom);
      });
      assert.ok(
        doc.querySelector(
          '[data-changes-item="contract/broken.md"] [role="alert"]',
        ),
      );
      expect(trigger("contract/manual.pdf").getAttribute("aria-expanded")).toBe(
        "true",
      );
      await act(async () => {
        itemError = false;
        doc
          .querySelector<HTMLButtonElement>(
            '[data-changes-item="contract/broken.md"] [role="alert"] button',
          )!
          .click();
        await nextFrame(dom);
      });
      expect(
        doc.querySelector(
          '[data-changes-item="contract/broken.md"] [role="alert"]',
        ),
      ).toBeNull();
      await act(async () => {
        trigger("contract/manual.pdf").focus();
        files = files.filter((file) => file.path !== "contract/README.md");
        await refreshGitStatus("/aggregate");
        await nextFrame(dom);
      });
      expect(doc.activeElement).toBe(trigger("contract/manual.pdf"));
      expect(trigger("contract/manual.pdf").getAttribute("aria-expanded")).toBe(
        "true",
      );
      expect(reads.includes("contract/image.png")).toBe(false);
      await act(async () => {
        files = files.filter((file) => file.path !== "contract/manual.pdf");
        await refreshGitStatus("/aggregate");
        await nextFrame(dom);
      });
      expect(doc.activeElement).toBe(trigger("contract/broken.md"));
      await act(async () => {
        repositoryError = true;
        await refreshGitStatus("/aggregate");
        await nextFrame(dom);
      });
      assert.ok(doc.querySelector('[data-changes-body] > [role="alert"]'));
      expect(
        doc.querySelector<HTMLButtonElement>(
          '[data-slot="sheet-footer"] button',
        )!.disabled,
      ).toBe(true);
      await act(async () => {
        repositoryError = false;
        doc
          .querySelector<HTMLButtonElement>(
            '[data-changes-body] > [role="alert"] button',
          )!
          .click();
        await nextFrame(dom);
      });
      const footer = () =>
        doc.querySelector<HTMLButtonElement>(
          '[data-slot="sheet-footer"] button:last-child',
        )!;
      await selectChangeFilter(dom, "Modified");
      await act(async () => {
        trigger("contract/broken.md").focus();
        files = files.map((file) =>
          file.path === "contract/broken.md"
            ? { ...file, state: "deleted" as const }
            : file,
        );
        await refreshGitStatus("/aggregate");
        await nextFrame(dom);
      });
      expect(triggers().length).toBe(0);
      expect(doc.activeElement).toBe(doc.querySelector("[data-changes-body]"));
      expect(doc.querySelector("[data-changes-summary]")?.textContent).toBe(
        "−0+0",
      );
      await selectChangeFilter(dom, "All files");
      expect(footer().textContent?.includes("Ctrl+Shift+S")).toBe(true);
      await act(async () => {
        footer().click();
        await nextFrame(dom);
      });
      expect(scopes.length).toBe(1);
      expect(scopes[0]).toEqual({
        nodePath: "contract/README.md",
        hasSchema: false,
        label: "folder",
        kind: "container",
        path: "contract",
      });
      expect(trigger("contract/broken.md").getAttribute("aria-expanded")).toBe(
        "true",
      );
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
        );
        await nextFrame(dom);
      });
      expect(saveCurrent).toBe(1);
      expect(scopes.length).toBe(1);
      await act(async () => {
        failSave = false;
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            shiftKey: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(scopes.length).toBe(2);
      expect(scopes[1]).toEqual(scopes[0]);
      assert.ok(doc.querySelector('[role="dialog"]'));
      expect(doc.querySelector('[data-slot="sheet-footer"]')).toBeNull();
      expect(triggers()).toEqual([]);
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      release();
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });

  test("Space footer commits its bounded paths while ordinary Save current reaches the owner", async () => {
    const dom = createDom();
    const restore = installDomGlobals(dom);
    const base = {
      branch: "main",
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: true,
      hasConflicts: false,
      tracking: null,
    };
    let files = [
      { path: ".svode/config.json", state: "modified" },
      { path: "inline/note.md", state: "modified" },
      ...Array.from({ length: 48 }, (_, index) => ({
        path: `inline/note-${index}.md`,
        state: "modified",
      })),
      { path: "removed.md", state: "deleted" },
    ];
    const allPaths = files.map((file) => file.path);
    const batches: number[] = [];
    let finishStats: (() => void) | undefined;
    const commits: unknown[] = [];
    mockNativeIpc(
      (command, args) => {
        if (command === "git_status") return { ...base, files };
        if (command === "git_inspection_stats") {
          const input = args as { paths: string[]; generation: string };
          batches.push(input.paths.length);
          const response = {
            generation: input.generation,
            items: input.paths.map((path) => ({
              path,
              additions: path === "removed.md" ? 0 : 2,
              deletions: path === "removed.md" ? 9 : 1,
            })),
          };
          return input.paths.includes("removed.md")
            ? new Promise((resolve) => {
                finishStats = () => resolve(response);
              })
            : response;
        }
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "space-repo",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_commit_paths") {
          commits.push(args);
          files = [];
          return { ...base, files };
        }
        if (command === "git_get_user_policy") return { autoSync: false };
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { ChangesControl } = await import("./changes-control");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    let currentSurface = 0;
    const current = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.shiftKey && event.key === "s")
        currentSurface++;
    };
    dom.window.addEventListener("keydown", current);
    const root = createRoot(dom.window.document.getElementById("app")!);
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ChangesControl
              target={{
                kind: "project",
                sourceShape: "directory",
                spacePath: "/root-scope",
                path: "README.md",
                name: "Project",
              }}
            />
          </TooltipProvider>,
        );
        await nextFrame(dom);
      });
      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-changes-trigger]")!
          .click();
        await nextFrame(dom);
      });
      const doc = dom.window.document;
      expect(doc.querySelectorAll("[data-changes-item-trigger]").length).toBe(
        50,
      );
      expect(batches).toEqual([50, 1]);
      expect(doc.querySelector("[data-changes-summary]")).toBeNull();
      assert.ok(doc.querySelector('[data-changes-toolbar] [role="status"]'));
      await act(async () => {
        finishStats!();
        await nextFrame(dom);
      });
      expect(doc.querySelector("[data-changes-summary]")?.textContent).toBe(
        "−59+100",
      );
      expect(
        doc
          .querySelector('[data-changes-toolbar] [role="combobox"]')
          ?.textContent?.includes("51"),
      ).toBe(true);
      await selectChangeFilter(dom, "Deleted");
      expect(doc.querySelectorAll("[data-changes-item-trigger]").length).toBe(
        1,
      );
      expect(
        doc
          .querySelector("[data-changes-item-trigger]")
          ?.getAttribute("data-changes-item-trigger"),
      ).toBe("removed.md");
      expect(doc.querySelector("[data-changes-summary]")?.textContent).toBe(
        "−9+0",
      );
      await selectChangeFilter(dom, "Added");
      expect(doc.querySelectorAll("[data-changes-item-trigger]").length).toBe(
        0,
      );
      expect(
        doc
          .querySelector("[data-changes-body]")
          ?.textContent?.includes("No files of this type"),
      ).toBe(true);
      expect(doc.querySelector("[data-changes-summary]")?.textContent).toBe(
        "−0+0",
      );
      expect(batches).toEqual([50, 1]);
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
        );
        await nextFrame(dom);
      });
      expect(currentSurface).toBe(1);
      expect(commits).toEqual([]);
      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>(
            '[data-slot="sheet-footer"] button',
          )!
          .click();
        await nextFrame(dom);
      });
      expect(commits.length).toBe(1);
      const committed = commits[0] as {
        spacePath: string;
        filePaths: string[];
      };
      expect({
        spacePath: committed.spacePath,
        filePaths: committed.filePaths,
      }).toEqual({
        spacePath: "/root-scope",
        filePaths: allPaths,
      });
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      dom.window.removeEventListener("keydown", current);
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });
  test("save errors retain safe localized causes and optional parent failure preserves child success", async () => {
    const dom = createDom();
    const restore = installDomGlobals(dom);
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const originalLocale = getLocale();
    const { ChangesControl } = await import("./changes-control");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { ThemeProvider } = await import("@/components/ui/theme-provider");
    const base = {
      branch: "main",
      ahead: 0,
      behind: 0,
      hasStaged: true,
      hasUnstaged: true,
      hasConflicts: false,
      tracking: null,
    };
    const paths = ["Исследования/README.md", "zadachi-komplaens/a.md"];
    const changedFiles = () =>
      paths.map((path) => ({ path, state: "untracked" }));
    let files = changedFiles();
    let error: unknown = null;
    let parent: object | undefined;
    let finish: (() => void) | null = null;
    let delayed = false;
    const commits: unknown[] = [];
    const calls: string[] = [];
    const logs: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args);
    };
    mockNativeIpc(
      (command, args) => {
        calls.push(command);
        if (command === "git_status") return { ...base, files };
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "df118-repo",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_inspection_stats") {
          const input = args as { paths: string[]; generation: string };
          return {
            generation: input.generation,
            items: input.paths.map((path) => ({
              path,
              additions: 1,
              deletions: 0,
            })),
          };
        }
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_commit_paths") {
          commits.push(args);
          const result = () => {
            if (error) throw error;
            files = [];
            return { ...base, files, parent };
          };
          return delayed
            ? new Promise((resolve, reject) => {
                finish = () => {
                  try {
                    resolve(result());
                  } catch (cause) {
                    reject(cause);
                  }
                };
              })
            : result();
        }
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    const doc = dom.window.document;
    const save = () =>
      doc.querySelector<HTMLButtonElement>(
        '[data-slot="sheet-footer"] button:last-child',
      )!;
    const alert = () =>
      doc.querySelector('[data-slot="sheet-footer"] [role="alert"]');
    const render = (theme: "light" | "dark") =>
      root.render(
        <ThemeProvider theme={theme} setTheme={() => {}}>
          <TooltipProvider>
            <ChangesControl
              origin="peek"
              target={{
                kind: "space",
                sourceShape: "directory",
                spacePath: "/df118",
                projectPath: "/df118-parent",
                path: "README.md",
                name: "Research",
              }}
            />
          </TooltipProvider>
        </ThemeProvider>,
      );
    try {
      await act(async () => {
        render("light");
        await nextFrame(dom);
      });
      await act(async () => {
        doc.querySelector<HTMLButtonElement>("[data-changes-trigger]")!.click();
        await nextFrame(dom);
      });
      const cases = [
        {
          stage: "prepare",
          reason: "command_failed",
          exitCode: 23,
          pathCount: 2,
          pathSample: paths[1],
        },
        {
          stage: "verify",
          reason: "paths_not_prepared",
          exitCode: null,
          pathCount: 1,
          pathSample: `Исследования/${"я".repeat(300)}.md`,
        },
        {
          stage: "commit",
          reason: "command_failed",
          exitCode: 1,
          pathCount: 2,
          pathSample: paths[0],
        },
      ];
      for (const locale of ["en", "ru"] as const) {
        await act(async () => {
          await setLocale(locale, { reload: false });
          render(locale === "en" ? "light" : "dark");
          await nextFrame(dom);
        });
        for (const cause of cases) {
          error = {
            kind: "git_save_failed",
            ...cause,
            stderr: "SECRET_HOOK",
            stdout: "SECRET_HOOK",
            message: "/Users/private/SECRET_HOOK",
          };
          await act(async () => {
            save().focus();
            save().click();
            await nextFrame(dom);
          });
          const content = alert()?.textContent ?? "";
          expect(
            content.includes(
              locale === "en"
                ? "Your changes remain available"
                : "Изменения остаются доступны",
            ),
          ).toBe(true);
          expect(
            content.includes(
              locale === "en"
                ? cause.stage === "prepare"
                  ? "Could not prepare"
                  : cause.stage === "verify"
                    ? "Could not confirm"
                    : "Could not create"
                : cause.stage === "prepare"
                  ? "Не удалось подготовить"
                  : cause.stage === "verify"
                    ? "Не удалось подтвердить"
                    : "Не удалось создать",
            ),
          ).toBe(true);
          expect(content.includes("SECRET_HOOK")).toBe(false);
          expect(content.includes("/Users/")).toBe(false);
          expect(doc.activeElement).toBe(save());
          expect(save().disabled).toBe(false);
          expect(
            doc.querySelectorAll("[data-changes-item-trigger]").length,
          ).toBe(2);
          if (cause.stage === "verify") {
            expect(content.includes("…")).toBe(true);
            expect(content.length < 600).toBe(true);
            expect(
              alert()
                ?.querySelector('[data-slot="alert-description"]')
                ?.className.includes("overflow-wrap:anywhere"),
            ).toBe(true);
          }
        }
        error = {
          kind: "git_command_failed",
          message: "SECRET_HOOK permission denied /Users/private",
        };
        await act(async () => {
          save().click();
          await nextFrame(dom);
        });
        expect(
          alert()?.textContent?.includes(
            locale === "en" ? "The cause is unknown" : "Причина не определена",
          ),
        ).toBe(true);
        expect(doc.body.textContent?.includes("SECRET_HOOK")).toBe(false);
        expect(calls.includes("repository_access_verify")).toBe(false);
      }
      delayed = true;
      error = null;
      parent = {
        repository: "/project",
        pointer: "pending",
        error: { kind: "repository_access_denied", status: "read_only" },
      };
      const before = commits.length;
      await act(async () => {
        save().click();
        save().click();
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            shiftKey: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(commits.length).toBe(before + 1);
      expect(save().disabled).toBe(true);
      expect(alert()).toBeNull();
      await act(async () => {
        finish!();
        await nextFrame(dom);
      });
      expect(alert()).toBeNull();
      expect(doc.querySelector('[data-slot="sheet-footer"]')).toBeNull();
      const { useGitStore } = await import("@/features/git");
      expect(useGitStore.getState().publications["/df118"]?.child).toBe(
        "local",
      );
      expect(
        useGitStore.getState().publications["/df118"]?.parent.error?.status,
      ).toBe("read_only");
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            shiftKey: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(commits.length).toBe(before + 1);
      assert.ok(doc.querySelector('[role="dialog"]'));
      expect(JSON.stringify(logs).includes("SECRET_HOOK")).toBe(false);
      useGitStore.getState().clear("/df118");
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      await setLocale(originalLocale, { reload: false });
      console.error = originalError;
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });

  test("the control stays a quiet icon until its scope has changes", async () => {
    const dom = createDom();
    const restore = installDomGlobals(dom);
    let files: { path: string; state: string }[] = [];
    let failStatus = false;
    mockNativeIpc(
      (command) => {
        if (command === "git_status") {
          if (failStatus) throw new Error("Synthetic status failure");
          return {
            branch: "main",
            ahead: 0,
            behind: 0,
            hasStaged: false,
            hasUnstaged: files.length > 0,
            hasConflicts: false,
            tracking: null,
            files,
          };
        }
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "df103-quiet",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { ChangesControl } = await import("./changes-control");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { refreshGitStatus } = await import("@/features/git");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const originalLocale = getLocale();
    const originalError = console.error;
    console.error = () => undefined;
    const root = createRoot(dom.window.document.getElementById("app")!);
    const doc = dom.window.document;
    const trigger = () =>
      doc.querySelector<HTMLButtonElement>("[data-changes-trigger]")!;
    const refresh = async () => {
      await act(async () => {
        await refreshGitStatus("/df103-quiet");
        await nextFrame(dom);
      });
    };
    try {
      await setLocale("en", { reload: false });
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ChangesControl
              target={{
                kind: "page",
                sourceShape: "file",
                spacePath: "/df103-quiet",
                path: "notes/plan.md",
                name: "Plan",
              }}
            />
          </TooltipProvider>,
        );
        await nextFrame(dom);
      });
      await refresh();
      expect(trigger().dataset.changesDirty).toBe("false");
      expect(trigger().dataset.size).toBe("icon-sm");
      expect(trigger().dataset.variant).toBe("ghost");
      expect(trigger().className.includes("text-muted-foreground")).toBe(true);
      expect(trigger().getAttribute("aria-label")).toBe("No changes in Plan");
      expect(trigger().textContent).toBe("");
      expect(trigger().querySelector('[data-slot="badge"]')).toBeNull();

      files = [{ path: "other/readme.md", state: "modified" }];
      await refresh();
      expect(trigger().dataset.changesDirty).toBe("false");

      files = [
        { path: "notes/plan.md", state: "modified" },
        { path: "other/readme.md", state: "modified" },
      ];
      await refresh();
      expect(trigger().dataset.changesDirty).toBe("true");
      expect(trigger().dataset.size).toBe("sm");
      expect(trigger().dataset.variant).toBe("ghost");
      expect(trigger().className.includes("text-muted-foreground")).toBe(false);
      expect(trigger().getAttribute("aria-label")).toBe("Changes in Plan: 1");
      expect(trigger().textContent).toBe("Changes1");
      expect(trigger().querySelector('[data-slot="badge"]')?.textContent).toBe(
        "1",
      );

      await setLocale("ru", { reload: false });
      files = [];
      await refresh();
      expect(trigger().getAttribute("aria-label")).toBe(
        "Нет изменений в «Plan»",
      );

      failStatus = true;
      await refresh();
      expect(trigger().dataset.changesDirty).toBe("false");
      expect(trigger().getAttribute("aria-label")).toBe("Изменения в «Plan»");
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      await setLocale(originalLocale, { reload: false });
      console.error = originalError;
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });

  test("switching Changes targets and sessions discards prior errors and late recovery", async () => {
    const dom = createDom();
    const restore = installDomGlobals(dom);
    const { ChangesControl } = await import("./changes-control");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { registerPageSaveOwner } = await import("@/features/git/editor");
    mockNativeIpc(
      (command, args) => {
        if (command === "git_status")
          return {
            branch: "main",
            ahead: 0,
            behind: 0,
            hasStaged: false,
            hasUnstaged: true,
            hasConflicts: false,
            tracking: null,
            files: ["old.md", "new.md"].map((path) => ({
              path,
              state: "modified",
            })),
          };
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "df118-switch",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_working_tree_item")
          return {
            ...(args as object),
            state: "no_content_diff",
            before: "same",
            after: "same",
          };
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    let rejectOld: ((error: unknown) => void) | null = null;
    let newSaves = 0;
    const releases = [
      registerPageSaveOwner("/df118-switch", "old.md", {
        save: () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
        saveAll: async () => {},
      }),
      registerPageSaveOwner("/df118-switch", "new.md", {
        save: async () => {
          newSaves++;
          throw {
            kind: "git_save_failed",
            stage: "prepare",
            reason: "paths_not_prepared",
            pathCount: 1,
            pathSample: "new.md",
          };
        },
        saveAll: async () => {},
      }),
    ];
    const root = createRoot(dom.window.document.getElementById("app")!);
    const doc = dom.window.document;
    const render = (path: string, sessionKey = 1) =>
      root.render(
        <TooltipProvider>
          <ChangesControl
            target={{
              kind: "page",
              sourceShape: "file",
              spacePath: "/df118-switch",
              path,
              name: path,
              sessionKey,
            }}
          />
        </TooltipProvider>,
      );
    const save = () =>
      doc.querySelector<HTMLButtonElement>(
        '[data-slot="sheet-footer"] button:last-child',
      )!;
    const alert = () =>
      doc.querySelector('[data-slot="sheet-footer"] [role="alert"]');
    try {
      await act(async () => {
        render("old.md");
        await nextFrame(dom);
      });
      await act(async () => {
        doc.querySelector<HTMLButtonElement>("[data-changes-trigger]")!.click();
        await nextFrame(dom);
      });
      await act(async () => {
        save().click();
        await nextFrame(dom);
      });
      expect(save().disabled).toBe(true);
      await act(async () => {
        render("new.md");
        await nextFrame(dom);
      });
      assert.ok(doc.querySelector('[role="dialog"]'));
      expect(save().disabled).toBe(false);
      await act(async () => {
        save().click();
        await nextFrame(dom);
      });
      expect(alert()?.textContent?.includes("new.md")).toBe(true);
      await act(async () => {
        rejectOld!({
          kind: "git_save_partial",
          cause: {
            kind: "repository_access_denied",
            repositoryId: "df118-switch",
            status: "read_only",
            reason: "auth_required",
          },
        });
        await nextFrame(dom);
      });
      expect(alert()?.textContent?.includes("new.md")).toBe(true);
      expect(alert()?.textContent?.includes("Content saved")).toBe(false);
      expect(
        doc.querySelectorAll('[data-slot="sheet-footer"] button').length,
      ).toBe(1);
      await act(async () => {
        render("new.md", 2);
        await nextFrame(dom);
      });
      expect(alert()).toBeNull();
      expect(save().disabled).toBe(false);
      await act(async () => {
        save().click();
        await nextFrame(dom);
      });
      expect(newSaves).toBe(2);
      await act(async () => {
        render("old.md", 3);
        await nextFrame(dom);
      });
      expect(alert()).toBeNull();
      await act(async () => {
        render("new.md", 2);
        await nextFrame(dom);
      });
      expect(alert()).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      releases.forEach((release) => release());
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextFrame(dom: JSDOM) {
  return new Promise<void>((resolve) => {
    dom.window.setTimeout(
      () => dom.window.requestAnimationFrame(() => resolve()),
      0,
    );
  });
}

async function selectChangeFilter(dom: JSDOM, label: string) {
  const doc = dom.window.document;
  await act(async () => {
    const trigger = doc.querySelector<HTMLElement>(
      '[data-changes-toolbar] [role="combobox"]',
    )!;
    trigger.focus();
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await nextFrame(dom);
  });
  const options = [...doc.querySelectorAll<HTMLElement>('[role="option"]')];
  const option = options.find((item) => item.textContent?.startsWith(label))!;
  assert.ok(option);
  assert.ok(option.querySelector("svg"));
  await act(async () => {
    option.click();
    await nextFrame(dom);
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    customElements: dom.window.customElements,
    CSSStyleSheet: class extends dom.window.CSSStyleSheet {
      replaceSync() {}
    },
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLPreElement: dom.window.HTMLPreElement,
    HTMLStyleElement: dom.window.HTMLStyleElement,
    SVGElement: dom.window.SVGElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
