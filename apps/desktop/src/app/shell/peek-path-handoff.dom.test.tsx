import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { Page } from "@/features/page";

if (process.env.SVODE_PEEK_PATH_HANDOFF_TEST !== "1") {
  test("Peek path handoff through the real Collection, Peek and Page detail", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PEEK_PATH_HANDOFF_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  let convert: (path: string) => void = () => {};
  let mounts = 0;
  const record = () => {};
  mock.module("sonner", () => ({
    toast: Object.assign(record, {
      error: record,
      info: record,
      success: record,
      warning: record,
      dismiss: () => {},
      get: () => undefined,
    }),
    Toaster: () => null,
  }));
  mock.module("@/features/editor", () => ({
    editorShortcuts: [],
    ControlledMarkdownEditor: () => null,
    PlateDocumentEditor: function Editor(props: {
      documentPath: string;
      initialPage: Page;
      onDocumentPathChange(path: string): void;
      registerPersistence(
        kind: "body",
        participant: {
          flush: () => Promise<void>;
          discard: () => Promise<void>;
        },
      ): () => void;
    }) {
      convert = props.onDocumentPathChange;
      const { registerPersistence } = props;
      useEffect(() => {
        mounts += 1;
        return registerPersistence("body", {
          flush: async () => {},
          discard: async () => {},
        });
      }, [registerPersistence]);
      return <textarea data-editor={props.documentPath} readOnly />;
    },
  }));

  const bootDom = new JSDOM("<!doctype html><div />", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  installDomGlobals(bootDom);
  const { ScopeSurfacePage } = await import("./scope-surface-page");
  const { CompactScopePeek } = await import("./compact-scope-peek");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { CollectionDetailDrawerProvider } =
    await import("@/features/collection/app-shell");
  const { createCollectionDirectoryOwner } =
    await import("@/features/scope-surfaces");
  const { emit } = await import("@/platform/native/events");

  const SPACE = "/space";
  const schema = {
    columns: [
      { name: "Note", type: "text" },
      { name: "Done", type: "boolean" },
      {
        name: "Owner",
        type: "relation",
        relation: "people",
        twoWay: "Tasks",
      },
    ],
    views: [{ name: "Table", type: "table" }],
  };
  const peopleSchema = {
    columns: [
      { name: "Tasks", type: "relation", relation: "tasks", twoWay: "Owner" },
    ],
    views: [{ name: "Table", type: "table" }],
  };

  // DF-130 fixture: `tasks` with a two-way `Owner` relation to `people`.
  function fixture(options: { facts?: (path: string) => unknown } = {}) {
    const files = new Map<string, ReturnType<typeof page>>([
      ["tasks/README.md", page("tasks/README.md", "tasks", {})],
      [
        "tasks/Item2.md",
        page("tasks/Item2.md", "Item2", {
          Note: "old",
          Done: true,
          Owner: "people/Ada.md",
        }),
      ],
      [
        "tasks/Item3.md",
        page("tasks/Item3.md", "Item3", { Note: "x", Done: false }),
      ],
      [
        "people/Ada.md",
        page("people/Ada.md", "Ada", { Tasks: ["tasks/Item2.md"] }),
      ],
    ]);
    mockNativeIpc(
      (command, rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        switch (command) {
          case "repository_access_get":
            return {
              status: "local",
              repositoryId: SPACE,
              generation: 1,
              checkedAt: null,
              expiresAt: null,
              reason: null,
              lastKnownStatus: null,
            };
          case "read_entry": {
            const file = files.get(String(args.path));
            if (!file) throw `File not found: ${String(args.path)}`;
            return file;
          }
          case "get_entry_schema": {
            const path = String(args.filePath ?? args.path ?? "");
            return path.startsWith("tasks/") && path !== "tasks/README.md"
              ? { schema, collectionRootPath: "tasks" }
              : null;
          }
          case "get_collection_schema":
            return args.collectionPath === "people" ? peopleSchema : schema;
          case "get_scope_owner_facts": {
            const path = String(args.path);
            const facts = options.facts?.(path);
            if (facts) return facts;
            if (!files.has(path)) throw `File not found: ${path}`;
            return {
              identity: "pageFile",
              ownerPath: path,
              contentPath: path,
              hasApp: false,
            };
          }
          case "query_entries":
            return [...files.values()].filter(
              (file) =>
                file.path.startsWith(`${String(args.collectionPath)}/`) &&
                !file.path.endsWith("README.md"),
            );
          case "list_collections":
            return [
              { path: "tasks", title: "tasks", nested: false },
              { path: "people", title: "people", nested: false },
            ];
          case "update_entry_field": {
            // Title save renames the file and rewrites the reverse relation.
            const from = String(args.filePath);
            const current = files.get(from)!;
            const title = String(args.value);
            const to = `tasks/${title}.md`;
            const next = {
              ...current,
              path: to,
              meta: { ...current.meta, title },
            };
            files.delete(from);
            files.set(to, next);
            const ada = files.get("people/Ada.md")!;
            files.set("people/Ada.md", {
              ...ada,
              meta: { ...ada.meta, extra: { Tasks: [to] } },
            });
            return next;
          }
          case "get_entry_detail_state":
            return { form: "leaf", subpageCount: 0, otherFileCount: 0 };
          case "resolve_relations_batch":
            return (args.values as string[]).map((value) => {
              const file = files.get(value);
              return file
                ? {
                    title: file.meta.title,
                    filePath: file.path,
                    collectionRootPath: file.path.split("/")[0],
                  }
                : null;
            });
          case "git_status":
            return { files: [], branch: "main" };
          case "get_expanded_paths":
            return [];
          case "list_templates":
            return [];
          default:
            return null;
        }
      },
      { shouldMockEvents: true },
    );
    return files;
  }

  function render(dom: JSDOM, children: ReactNode) {
    const root = createRoot(dom.window.document.getElementById("app")!);
    root.render(
      <ThemeProvider theme="light" setTheme={() => {}}>
        <TooltipProvider>
          <CollectionDetailDrawerProvider>
            {children}
          </CollectionDetailDrawerProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    return root;
  }

  function captureErrors() {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    return {
      errors,
      failure: () =>
        errors.find(
          (entry) =>
            entry[0] === "Scope surface render failed" ||
            String(entry[0]).includes("Maximum update depth"),
        ),
      restore: () => {
        console.error = original;
      },
    };
  }

  test("E130-1: rename title from Peek keeps the parent Collection and the Peek on the new path", async () => {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    const reported = captureErrors();
    fixture();
    const owner = createCollectionDirectoryOwner({
      status: "ready",
      spaceId: "space-1",
      spacePath: SPACE,
      projectPath: SPACE,
      ownerPath: "tasks",
      hasSchema: true,
      hasApp: false,
    } as never);
    let root: ReturnType<typeof createRoot> | null = null;
    const text = () => dom.window.document.body.textContent ?? "";
    try {
      await act(async () => {
        root = render(
          dom,
          <ScopeSurfacePage
            owner={owner}
            presentation="full"
            openIntent={{ kind: "target", surfaceId: "collection" }}
            openRequestKey={1}
          />,
        );
        await settle(20);
      });
      const row = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>("tr"),
      ).find((item) => item.textContent?.includes("Item2"))!;
      await act(async () => {
        row.dispatchEvent(
          new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }),
        );
        await settle(20);
      });
      const title = Array.from(
        dom.window.document.querySelectorAll<HTMLInputElement>(
          'input[type="text"]',
        ),
      ).find((input) => input.value === "Item2")!;
      expect(Boolean(title)).toBe(true);
      // Portal events do not reach React under this JSDOM setup; drive the
      // title field through its React handlers (TitleZone commits on blur).
      const titleProps = () =>
        (
          title as unknown as Record<
            string,
            { onChange(event: unknown): void; onBlur(): void }
          >
        )[Object.keys(title).find((key) => key.startsWith("__reactProps"))!]!;
      await act(async () => {
        title.focus();
        titleProps().onChange({ target: { value: "Item234" } });
      });
      await act(async () => {
        titleProps().onBlur();
        await settle(20);
      });
      await act(async () => {
        for (const path of [
          "tasks/Item2.md",
          "tasks/Item234.md",
          "people/Ada.md",
        ])
          await emit("file:changed", { path, space: SPACE });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await settle(20);
      });

      expect(reported.failure()).toBe(undefined);
      expect(text().includes("Unable to display this section")).toBe(false);
      const inputs = Array.from(
        dom.window.document.querySelectorAll<HTMLInputElement>(
          'input[type="text"]',
        ),
      ).map((input) => input.value);
      expect(inputs.includes("Item234")).toBe(true);
      expect(
        dom.window.document.querySelector(
          'textarea[data-editor="tasks/Item234.md"]',
        ) === null,
      ).toBe(false);
      expect(
        Array.from(dom.window.document.querySelectorAll("tr")).some((item) =>
          item.textContent?.includes("Item234"),
        ),
      ).toBe(true);
    } finally {
      reported.restore();
      await act(async () => root?.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  }, 30_000);

  test("a conversion inside a Peek hands its new path to the host once while the owner of that path is unresolved", async () => {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    const reported = captureErrors();
    let resolveFacts: (facts: unknown) => void = () => {};
    const unresolvedFacts = new Promise((resolve) => {
      resolveFacts = resolve;
    });
    const files = fixture({
      facts: (path) =>
        path === "tasks/Item2/README.md" ? unresolvedFacts : null,
    });
    const published: string[] = [];
    let root: ReturnType<typeof createRoot> | null = null;
    mounts = 0;
    try {
      await act(async () => {
        root = render(
          dom,
          <CompactScopePeek
            path="tasks/Item2.md"
            spaceId="space-1"
            spacePath={SPACE}
            projectPath={SPACE}
            sessionKey="peek-1"
            renderActions={() => null}
            registerNavigationGuard={() => () => {}}
            onContentPathChange={(path) => published.push(path)}
            dismiss={() => {}}
          />,
        );
        await settle(20);
      });
      expect(
        dom.window.document.querySelector(
          'textarea[data-editor="tasks/Item2.md"]',
        ) === null,
      ).toBe(false);
      const converted = {
        ...files.get("tasks/Item2.md")!,
        path: "tasks/Item2/README.md",
      };
      files.delete("tasks/Item2.md");
      files.set(converted.path, converted);
      await act(async () => {
        convert("tasks/Item2/README.md");
        await settle(20);
      });
      expect(reported.failure()).toBe(undefined);
      expect(published).toEqual(["tasks/Item2/README.md"]);

      await act(async () => {
        resolveFacts({
          identity: "pageDirectory",
          ownerPath: "tasks/Item2",
          contentPath: "tasks/Item2/README.md",
          hasApp: false,
        });
        await settle(20);
      });
      expect(reported.failure()).toBe(undefined);
      expect(published).toEqual(["tasks/Item2/README.md"]);
      expect(
        dom.window.document.querySelector(
          'textarea[data-editor="tasks/Item2/README.md"]',
        ) === null,
      ).toBe(false);
      expect(mounts).toBe(1);
    } finally {
      reported.restore();
      await act(async () => root?.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  }, 30_000);
}

function page(path: string, title: string, extra: Record<string, unknown>) {
  return {
    path,
    body: "",
    meta: {
      title,
      icon: null,
      created: "2026-09-20T00:00:00Z",
      updated: "2026-09-20T00:00:00Z",
      extra,
    },
    source_version: "v1",
  };
}

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
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
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    SVGElement: dom.window.SVGElement,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    IntersectionObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: dom.window.localStorage,
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
