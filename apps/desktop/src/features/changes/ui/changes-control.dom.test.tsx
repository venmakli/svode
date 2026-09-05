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
    const reads: string[] = [];
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
    ].map((path) => ({ path, state: "modified" as const }));
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
            state: input.path.endsWith("pdf") ? "binary" : "no_content_diff",
            before: null,
            after: null,
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
    try {
      await act(async () => {
        root.render(
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
          </TooltipProvider>,
        );
        await nextFrame(dom);
      });
      await act(async () => {
        doc.querySelector<HTMLButtonElement>("[data-changes-trigger]")!.click();
        await nextFrame(dom);
      });
      expect(triggers().length).toBe(4);
      expect(reads).toEqual([]);
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
      expect(
        triggers().filter(
          (node) => node.getAttribute("aria-expanded") === "true",
        ).length,
      ).toBe(2);
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
    ];
    const commits: unknown[] = [];
    mockNativeIpc(
      (command, args) => {
        if (command === "git_status") return { ...base, files };
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
        filePaths: [".svode/config.json", "inline/note.md"],
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

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
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
