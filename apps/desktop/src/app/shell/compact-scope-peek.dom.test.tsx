import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { Page } from "@/features/page";

if (process.env.SVODE_COMPACT_SCOPE_TEST !== "1") {
  test("Compact Page integration through both real Sheet adapters", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COMPACT_SCOPE_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  let mounts = 0;
  let _unmounts = 0;
  let flushBody: () => Promise<void> = async () => {};
  let _convert: (path: string) => void = () => {};
  const allowCollectionNavigation = true;
  const appBroken = false;
  let headerBroken = false;
  const lifecycle: string[] = [];
  mock.module("@/features/editor", () => ({
    PlateDocumentEditor: function Editor(props: {
      documentPath: string;
      initialPage: Page;
      readOnly: boolean;
      registerPersistence(
        kind: "body",
        participant: {
          flush: () => Promise<void>;
          discard: () => Promise<void>;
        },
      ): () => void;
      onDocumentPathChange(path: string): void;
    }) {
      _convert = props.onDocumentPathChange;
      const { registerPersistence } = props;
      useEffect(() => {
        mounts += 1;
        const unregister = registerPersistence("body", {
          flush: () => flushBody(),
          discard: async () => {},
        });
        return () => {
          _unmounts += 1;
          unregister();
        };
      }, [registerPersistence]);
      return (
        <textarea
          data-editor={props.documentPath}
          defaultValue={props.initialPage.body}
          readOnly={props.readOnly}
        />
      );
    },
  }));
  mock.module("@/features/document", () => ({
    probeDocumentTarget: () => ({ status: "no_match" }),
  }));
  mock.module("@/features/media", () => ({
    probeMediaTarget: () => ({ status: "no_match" }),
  }));
  mock.module("@/features/properties/panel", () => ({
    PropertyPanel: () => null,
  }));
  mock.module("@/features/page/ui/page-identity-header", () => ({
    PageIdentityHeader: ({
      title,
      actions,
      readOnly,
    }: {
      title: string;
      actions: ReactNode;
      readOnly: boolean;
    }) => {
      if (headerBroken) throw new Error("Peek header failed");
      return (
        <header data-read-only={readOnly}>
          {title}
          {actions}
        </header>
      );
    },
    PageIdentityHeaderSkeleton: () => <header>Loading</header>,
  }));
  mock.module("@/features/page/ui/page-detail-actions", () => ({
    PageDetailActions: () => null,
  }));
  mock.module("@/features/page/ui/page-system-fields", () => ({
    PageSystemFields: () => null,
  }));
  mock.module("@/features/page/ui/page-delete-dialog", () => ({
    PageDeleteDialog: () => null,
  }));
  mock.module(
    "@/features/collection/app-shell/detail-controller-context",
    () => ({
      CollectionDetailStoreProvider: ({ children }: { children: ReactNode }) =>
        children,
      useCollectionDetailStore: () => null,
      useOptionalCollectionDetailController: () => null,
      useCollectionDetailController: () => ({
        prepareForNavigation: async () => allowCollectionNavigation,
      }),
    }),
  );
  mock.module("./app-with-variables", () => ({
    AppWithVariables: function App({
      owner,
    }: {
      owner: { ownerPath: string };
    }) {
      useEffect(() => {
        lifecycle.push("mount:app");
        return () => {
          lifecycle.push("unmount:app");
        };
      }, []);
      if (appBroken) throw new Error("App viewport failed");
      return <div data-app={owner.ownerPath} />;
    },
  }));
  mock.module("@/features/attachments/ui/attachments-surface", () => ({
    AttachmentsSurface: ({
      owner,
      readOnly,
    }: {
      owner: { contentPath: string; hasDirectCollection: boolean };
      readOnly: boolean;
    }) => (
      <div
        data-attachments={owner.contentPath}
        data-collection={owner.hasDirectCollection}
        data-read-only={readOnly}
      />
    ),
  }));
  mock.module("@/features/collection/scope-surface", () => ({
    CollectionViewsSurface: () => <div data-collection-view />,
  }));
  mock.module("@/features/routines", () => ({
    RoutinesSurface: () => <div data-routines />,
  }));
  const bootDom = new JSDOM("<!doctype html><div />", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  installDomGlobals(bootDom);
  const { CompactScopePeek } = await import("./compact-scope-peek");
  const { PagePeekSheet } = await import("@/features/collection/app-shell");
  const { AttachmentsPeek } = await import("@/features/attachments");
  const { AttachmentOwnerPeek } = await import("./attachment-owner-peek");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getActiveContentSelection, closeActiveContent } =
    await import("@/features/artifact");
  const { ScopeSurfaceErrorBoundary } =
    await import("@/features/scope-surfaces");
  const m = await import("@/paraglide/messages.js");
  test("Page+App+Attachments keeps one writer and selected Full page through Collection/relation/template and Attachments", async () => {
    for (const family of ["collection", "attachments"] as const) {
      const dom = new JSDOM("<!doctype html><div id=app></div>", {
        pretendToBeVisual: true,
        url: "http://localhost/?view=Original",
      });
      const restore = installDomGlobals(dom);
      mounts = 0;
      _unmounts = 0;
      let blocked = true;
      let hasApp = true;
      let ownerFactReads = 0;
      flushBody = async () => {
        if (blocked) throw new Error("save blocked");
      };
      const page: Page = {
        path: "Notes/README.md",
        body: "draft",
        meta: {
          title: "Notes",
          icon: null,
          created: "",
          updated: "",
          extra: {},
        },
      };
      mockNativeIpc(
        (command, args) => {
          if (command === "repository_access_get")
            return {
              status: "local",
              repositoryId: "/target",
              generation: 1,
              checkedAt: null,
              expiresAt: null,
              reason: null,
              lastKnownStatus: null,
            };
          if (command === "read_entry") return page;
          if (command === "get_entry_schema") return null;
          if (command === "get_scope_owner_facts") {
            ownerFactReads += 1;
            return {
              identity: "pageDirectory",
              ownerPath: "Notes",
              contentPath: String(args && "path" in args ? args.path : ""),
              hasApp,
            };
          }
          throw new Error(`Unexpected IPC: ${command}`);
        },
        { shouldMockEvents: true },
      );
      closeActiveContent();
      const root = createRoot(dom.window.document.getElementById("app")!);
      const owner = {
        ownerKey: "space:origin",
        identityKind: "registered-space" as const,
        projectPath: "/project",
        spacePath: "/origin",
        spaceId: "origin",
        ownerPath: ".",
        contentPath: "README.md",
        hasDirectCollection: false,
      };
      function Harness() {
        const [open, setOpen] = useState(true);
        return (
          <TooltipProvider>
            {family === "collection" ? (
              <PagePeekSheet
                target={
                  open
                    ? {
                        page,
                        nested: false,
                        spaceId: "target",
                        spacePath: "/target",
                        template: {
                          slug: "notes",
                          collectionPath: "Tasks",
                          isDefault: false,
                        },
                      }
                    : null
                }
                readOnly={true}
                spacePath="/origin"
                spaceId="origin"
                projectPath="/project"
                onOpenChange={setOpen}
                onOpenPath={() => {}}
                onDuplicatePage={() => {}}
                onDeletePage={() => {}}
                onConvertedPage={() => {}}
                renderPeek={(context) => (
                  <CompactScopePeek key={context.sessionKey} {...context} />
                )}
              />
            ) : (
              <AttachmentsPeek
                owner={owner}
                readOnly={true}
                target={
                  open
                    ? {
                        row: {
                          key: "page:Notes",
                          path: page.path,
                          contentPath: page.path,
                          ownerPath: "Notes",
                          sourcePath: page.path,
                          sourceShape: "directory",
                          kind: "page",
                          hasApp: true,
                          icon: null,
                          displayName: "Notes",
                          modified: "",
                          sizeBytes: null,
                          format: "",
                          availability: "available",
                        },
                        owner: {
                          projectPath: "/project",
                          spacePath: "/target",
                          spaceId: "target",
                          ownerPath: ".",
                          repositoryPath: "/target",
                        },
                        mode: "peek",
                        sourceGeneration: "one",
                        activation: { rowId: "page:Notes" },
                      }
                    : null
                }
                onOpenChange={setOpen}
                renderOwnerPeek={(context) => (
                  <AttachmentOwnerPeek {...context} />
                )}
              />
            )}
          </TooltipProvider>
        );
      }
      const previousError = console.error;
      console.error = previousError;
      try {
        await act(async () => {
          root.render(<Harness />);
          await settle();
        });
        expect(tabs(dom).map((tab) => tab.textContent)).toEqual([
          "Readme",
          "App",
          "Attachments",
        ]);
        const { emit } = await import("@/platform/native/events");
        const fileEvent = async (name: string, path: string) =>
          act(async () => {
            await emit(name, { space: "/target", path });
            await settle();
          });
        const reads = ownerFactReads;
        await fileEvent("file:changed", "Notes/Other.md");
        await fileEvent("file:created", "Notes/Sub/app.yaml");
        expect(ownerFactReads).toBe(reads);
        hasApp = false;
        await fileEvent("file:deleted", "Notes/app.yaml");
        expect(tabs(dom).map((tab) => tab.textContent)).toEqual([
          "Readme",
          "Attachments",
        ]);
        hasApp = true;
        await fileEvent("file:created", "Notes/app.yaml");
        expect(tabs(dom).map((tab) => tab.textContent)).toEqual([
          "Readme",
          "App",
          "Attachments",
        ]);
        expect(mounts).toBe(1);
        const editor = dom.window.document.querySelector("textarea")!;
        expect(editor.readOnly).toBe(false);
        editor.value = "unsaved draft";
        editor.setSelectionRange(2, 5);
        await clickTab(dom, 1);
        expect(dom.window.document.querySelector("[data-app]")).toBeNull();
        blocked = false;
        await clickTab(dom, 1);
        expect(Boolean(dom.window.document.querySelector("[data-app]"))).toBe(
          true,
        );
        expect(Boolean(editor.closest("[hidden]"))).toBe(true);
        await clickTab(dom, 0);
        expect(dom.window.document.querySelector("textarea")).toBe(editor);
        expect(editor.value).toBe("unsaved draft");
        expect(editor.selectionStart).toBe(2);
        expect(mounts).toBe(1);
        await clickTab(dom, 2);
        expect(dom.window.location.search).toBe("?view=Original");
        const full = [...dom.window.document.querySelectorAll("button")].find(
          (button) => /Full page|Expand/.test(button.textContent ?? ""),
        )!;
        await act(async () => {
          full.click();
          await settle();
        });
        const selected = getActiveContentSelection().selection;
        expect(selected?.kind).toBe("artifact");
        if (selected?.kind === "artifact") {
          expect(selected.request.intent.target.spaceId).toBe("target");
          expect(selected.request.intent.scopeOpenIntent).toEqual({
            kind: "target",
            surfaceId: "attachments",
          });
        }
      } finally {
        await act(async () => root.unmount());
        closeActiveContent();
        clearNativeMocks();
        console.error = previousError;
        restore();
        dom.window.close();
      }
    }
  }, 30000);
  test("render error inside Peek stays in its Sheet, is reported and the Peek can be closed", async () => {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    const page: Page = {
      path: "Tasks/Item2.md",
      body: "",
      meta: { title: "Item2", icon: null, created: "", updated: "", extra: {} },
    };
    mockNativeIpc(
      (command, args) => {
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "/space",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            reason: null,
            lastKnownStatus: null,
          };
        if (command === "read_entry") return page;
        if (command === "get_entry_schema") return null;
        if (command === "get_scope_owner_facts") {
          const path = String(args && "path" in args ? args.path : "");
          return {
            identity: "pageFile",
            ownerPath: path,
            contentPath: path,
            hasApp: false,
          };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <TooltipProvider>
          <ScopeSurfaceErrorBoundary>
            <div data-parent-collection />
            <PagePeekSheet
              target={open ? { page, nested: false } : null}
              readOnly={false}
              spacePath="/space"
              spaceId="space"
              projectPath="/space"
              onOpenChange={setOpen}
              onOpenPath={() => {}}
              onDuplicatePage={() => {}}
              onDeletePage={() => {}}
              onConvertedPage={() => {}}
              renderPeek={(context) => (
                <CompactScopePeek key={context.sessionKey} {...context} />
              )}
            />
          </ScopeSurfaceErrorBoundary>
        </TooltipProvider>
      );
    }
    const previousError = console.error;
    const reported: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      reported.push(args);
    };
    headerBroken = true;
    try {
      await act(async () => {
        root.render(<Harness />);
        await settle();
      });
      const document = dom.window.document;
      expect(Boolean(document.querySelector("[data-parent-collection]"))).toBe(
        true,
      );
      const sheet = document.querySelector('[data-slot="sheet-content"]');
      expect(sheet?.textContent?.includes(m.scope_surface_render_error())).toBe(
        true,
      );
      const report = reported.find(
        ([message]) => message === "Scope surface render failed",
      );
      expect((report?.[1] as Error | undefined)?.message).toBe(
        "Peek header failed",
      );
      expect(String(report?.[2]).includes("PageIdentityHeader")).toBe(true);
      const close = [...sheet!.querySelectorAll("button")].find(
        (button) => button.textContent === m.settings_cancel(),
      )!;
      await act(async () => {
        close.click();
        await settle();
      });
      expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
      expect(Boolean(document.querySelector("[data-parent-collection]"))).toBe(
        true,
      );
    } finally {
      headerBroken = false;
      await act(async () => root.unmount());
      clearNativeMocks();
      console.error = previousError;
      restore();
      dom.window.close();
    }
  });
  test("another writer's metadata reaches an open Peek without re-creating its editor", async () => {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    mounts = 0;
    let source: Page = {
      path: "Tasks/Item2.md",
      body: "saved body",
      meta: {
        title: "Item2",
        icon: null,
        created: "",
        updated: "",
        extra: {},
      },
    };
    mockNativeIpc(
      (command, args) => {
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: "/target",
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            reason: null,
            lastKnownStatus: null,
          };
        if (command === "read_entry") return structuredClone(source);
        if (command === "get_entry_schema") return null;
        if (command === "get_scope_owner_facts") {
          const path = String(args && "path" in args ? args.path : "");
          return {
            identity: "pageFile",
            ownerPath: path,
            contentPath: path,
            hasApp: false,
          };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    const page = source;
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <PagePeekSheet
              target={{
                page,
                nested: false,
                spaceId: "target",
                spacePath: "/target",
              }}
              readOnly={false}
              spacePath="/target"
              spaceId="target"
              projectPath="/target"
              onOpenChange={() => {}}
              onOpenPath={() => {}}
              onDuplicatePage={() => {}}
              onDeletePage={() => {}}
              onConvertedPage={() => {}}
              renderPeek={(context) => (
                <CompactScopePeek key={context.sessionKey} {...context} />
              )}
            />
          </TooltipProvider>,
        );
        await settle();
      });
      const editor = dom.window.document.querySelector("textarea")!;
      editor.value = "unsaved draft";
      expect(mounts).toBe(1);

      source = {
        ...source,
        body: "external body",
        meta: { ...source.meta, title: "Renamed by a Routine" },
      };
      const { emit } = await import("@/platform/native/events");
      await act(async () => {
        await emit("file:changed", { space: "/target", path: source.path });
        await settle();
      });
      expect(
        [...dom.window.document.querySelectorAll("header")].some((header) =>
          header.textContent?.includes("Renamed by a Routine"),
        ),
      ).toBe(true);
      expect(dom.window.document.querySelector("textarea")).toBe(editor);
      expect(editor.value).toBe("unsaved draft");
      expect(mounts).toBe(1);
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });
  test("peek replacement is guarded, ignores late targets and keeps canonical handoff in one session", async () => {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    const { usePeekNavigation } = await import("@/features/scope-surfaces");
    let navigation: ReturnType<typeof usePeekNavigation<{ path: string }>>;
    let allowed = false;
    let deferred: Promise<boolean> | null = null;
    let calls = 0;
    function Harness({ path }: { path: string }) {
      const requested = useMemo(() => ({ path }), [path]);
      const current = usePeekNavigation(requested, (target) => target.path);
      navigation = current;
      const { registerNavigationGuard } = current;
      useEffect(
        () =>
          registerNavigationGuard(async () => {
            calls++;
            return deferred ?? allowed;
          }),
        [registerNavigationGuard],
      );
      return <output>{current.target?.path}</output>;
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    const render = async (path: string) => {
      await act(async () => {
        root.render(<Harness path={path} />);
        await settle();
      });
    };
    try {
      await render("a");
      const originalSession = navigation!.sessionKey;
      await render("b");
      expect(navigation!.target?.path).toBe("a");
      allowed = true;
      await render("c");
      expect(navigation!.target?.path).toBe("c");
      expect(navigation!.sessionKey === originalSession).toBe(false);
      const session = navigation!.sessionKey;
      navigation!.adoptIdentity("renamed");
      await render("renamed");
      expect(navigation!.sessionKey).toBe(session);
      let resolve: (value: boolean) => void = () => {};
      deferred = new Promise<boolean>((done) => {
        resolve = done;
      });
      const before = calls;
      await render("late");
      await render("latest");
      await act(async () => {
        resolve(true);
        await settle();
      });
      expect(navigation!.target?.path).toBe("latest");
      expect(calls - before).toBe(1);
    } finally {
      await act(async () => root.unmount());
      restore();
      dom.window.close();
    }
  });

  function tabs(dom: JSDOM) {
    return Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
  }
  async function clickTab(dom: JSDOM, index: number) {
    await act(async () => {
      tabs(dom)[index]!.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      await settle();
    });
  }
  async function settle() {
    for (let i = 0; i < 5; i += 1)
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
}
