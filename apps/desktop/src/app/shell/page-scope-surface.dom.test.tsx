import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { Page } from "@/features/page";

if (process.env.SVODE_PAGE_SCOPE_TEST !== "1") {
  test("Artifact Page Scope integration", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_SCOPE_TEST: "1" },
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
  let unmounts = 0;
  let flushBody: () => Promise<void> = async () => {};
  let convert: (path: string) => void = () => {};
  let allowCollectionNavigation = true;
  let appBroken = false;
  const lifecycle: string[] = [];
  mock.module("@/features/editor", () => ({
    PlateDocumentEditor: function Editor(props: {
      documentPath: string;
      initialPage: Page;
      readOnly: boolean;
      registerPersistence(kind: "body", flush: () => Promise<void>): () => void;
      onDocumentPathChange(path: string): void;
    }) {
      convert = props.onDocumentPathChange;
      const { registerPersistence } = props;
      useEffect(() => {
        mounts += 1;
        const unregister = registerPersistence("body", () => flushBody());
        return () => {
          unmounts += 1;
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
    }) => (
      <header data-read-only={readOnly}>
        {title}
        {actions}
      </header>
    ),
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
  const { ArtifactSurface } = await import("@/features/artifact/app-shell");
  const { useActiveContentSelection, closeActiveContent } =
    await import("@/features/artifact");
  const { openPage, publishPageTitleOutcome } =
    await import("@/features/page/navigation");
  const { useMainChangesTarget } = await import("@/features/changes");
  const { PageScopeSurface } = await import("./page-scope-surface");
  function page(path: string): Page {
    return {
      path,
      body: "initial body",
      meta: { title: path, icon: null, created: "", updated: "", extra: {} },
    };
  }
  async function fixture(initialPath: string, folder = false) {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    appBroken = false;
    mounts = 0;
    unmounts = 0;
    lifecycle.length = 0;
    allowCollectionNavigation = true;
    flushBody = async () => {};
    let hasApp = folder;
    let status = "local";
    let reads = 0;
    const spacePath = `/df104-${Date.now()}-${Math.random()}`;
    mockNativeIpc(
      (command, args) => {
        if (command === "repository_access_get")
          return {
            status,
            repositoryId: spacePath,
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            reason: status === "local" ? null : "auth_required",
            lastKnownStatus: null,
          };
        if (command === "read_entry") {
          reads += 1;
          return page(String(args && "path" in args ? args.path : ""));
        }
        if (command === "get_entry_schema") return null;
        if (command === "get_entry_detail_state")
          return {
            form: folder ? "folder" : "leaf",
            subpageCount: 0,
            otherFileCount: 0,
          };
        throw new Error(`Unexpected IPC: ${command}`);
      },
      { shouldMockEvents: true },
    );
    closeActiveContent();
    openPage(initialPath, "root");
    function Harness() {
      const { selection, activePathRetarget } = useActiveContentSelection();
      const changes = useMainChangesTarget();
      if (selection?.kind !== "artifact") return null;
      const request = selection.request;
      return (
        <div data-scroll style={{ overflowY: "auto", height: 400 }}>
          <output
            data-changes={changes?.path}
            data-changes-kind={changes?.kind}
          />
          <ArtifactSurface
            request={request}
            spacePath={spacePath}
            projectPath={spacePath}
            spaceId="root"
            pageSessionKey={`root:${request.sessionKey}`}
            retainSurfaceDuringRetarget={
              activePathRetarget?.path === request.intent.target.path
            }
            renderPageSurface={(layout) => (
              <PageScopeSurface
                {...layout}
                spacePath={spacePath}
                projectPath={spacePath}
                spaceId="root"
                sessionKey={request.sessionKey}
                hasApp={hasApp}
              />
            )}
          />
        </div>
      );
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    async function render() {
      await act(async () => {
        root.render(<Harness />);
        await settle();
      });
      await act(settle);
    }
    await render();
    return {
      dom,
      spacePath,
      render,
      reads: () => reads,
      marker: async (value: boolean) => {
        hasApp = value;
        await render();
      },
      access: async (value: string) => {
        status = value;
        await act(async () => {
          dom.window.dispatchEvent(new dom.window.Event("focus"));
          await settle();
        });
      },
      remount: async () => {
        await act(async () => root.render(null));
        await render();
      },
      cleanup: async () => {
        await act(async () => root.unmount());
        closeActiveContent();
        clearNativeMocks();
        restore();
        dom.window.close();
      },
    };
  }
  test("Artifact Page conversion/rename retains editor transaction and common owner contributions", async () => {
    const f = await fixture("Note.md");
    try {
      const editor =
        f.dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(editor !== null).toBe(true);
      expect(
        f.dom.window.document.querySelector('[role="tablist"]'),
      ).toBeNull();
      editor.value = "pending transaction";
      editor.setSelectionRange(2, 8);
      await act(async () => {
        convert("Note/README.md");
        await settle();
      });
      expect(f.dom.window.document.querySelector("textarea")).toBe(editor);
      expect(editor.dataset.editor).toBe("Note/README.md");
      expect(mounts).toBe(1);
      expect(f.reads()).toBe(1);
      expect(tabs(f.dom).length).toBe(2);
      await f.marker(true);
      expect(tabs(f.dom).length).toBe(3);
      const scroller =
        f.dom.window.document.querySelector<HTMLElement>("[data-scroll]")!;
      scroller.scrollTop = 320;
      await clickTab(f.dom, 1);
      scroller.scrollTop = 0;
      expect(editor.closest("[hidden]") !== null).toBe(true);
      await act(async () => {
        publishPageTitleOutcome(
          f.spacePath,
          "Note/README.md",
          page("Renamed/README.md"),
        );
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      expect(editor.dataset.editor).toBe("Renamed/README.md");
      expect(
        f.dom.window.document
          .querySelector("[data-changes]")
          ?.getAttribute("data-changes"),
      ).toBe("Renamed/README.md");
      expect(
        f.dom.window.document
          .querySelector("[data-changes]")
          ?.getAttribute("data-changes-kind"),
      ).toBe("page");
      await clickTab(f.dom, 2);
      expect(
        f.dom.window.document
          .querySelector("[data-attachments]")
          ?.getAttribute("data-attachments"),
      ).toBe("Renamed/README.md");
      expect(
        f.dom.window.document
          .querySelector("[data-attachments]")
          ?.getAttribute("data-collection"),
      ).toBe("false");
      expect(lifecycle).toEqual(["mount:app", "unmount:app"]);
      await clickTab(f.dom, 0);
      expect(scroller.scrollTop).toBe(320);
      expect(editor.closest("[hidden]")).toBeNull();
      expect(editor.value).toBe("pending transaction");
      expect(editor.selectionStart).toBe(2);
      expect(editor.selectionEnd).toBe(8);
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test("Page serializes pending flush, retains failed save recovery and respects Collection guard", async () => {
    const f = await fixture("Guard/README.md", true);
    try {
      let calls = 0;
      let release!: () => void;
      flushBody = () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      await clickTab(f.dom, 1);
      await clickTab(f.dom, 2);
      expect(calls).toBe(1);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      await act(async () => {
        release();
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      await clickTab(f.dom, 0);
      flushBody = async () => {
        throw new Error("write failed");
      };
      await clickTab(f.dom, 1);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      expect(
        f.dom.window.document.querySelector('[role="alert"]') !== null,
      ).toBe(true);
      expect(
        f.dom.window.document.querySelector('[aria-busy="true"]'),
      ).toBeNull();
      flushBody = async () => {};
      allowCollectionNavigation = false;
      await clickTab(f.dom, 1);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      allowCollectionNavigation = true;
      await clickTab(f.dom, 1);
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      expect(mounts).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  test("Page open applies default once, remount preserves selection, marker fallback and repository recovery work", async () => {
    const f = await fixture("Open/README.md", true);
    try {
      await clickTab(f.dom, 1);
      await act(async () => {
        openPage("Open/README.md", "root");
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      await f.remount();
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      await f.marker(false);
      expect(tabs(f.dom).length).toBe(2);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      await f.marker(true);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      await f.access("read_only");
      expect(f.dom.window.document.querySelector("textarea")?.readOnly).toBe(
        true,
      );
      await clickTab(f.dom, 2);
      expect(
        f.dom.window.document
          .querySelector("[data-attachments]")
          ?.getAttribute("data-read-only"),
      ).toBe("true");
      await f.access("local");
      expect(f.dom.window.document.querySelector("textarea")?.readOnly).toBe(
        false,
      );
      const before = unmounts;
      await act(async () => {
        openPage("Other/README.md", "root");
        await settle();
      });
      await act(settle);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      expect(unmounts).toBe(before + 1);
      await act(async () => {
        openPage("Open/README.md", "root");
        await settle();
      });
      await act(settle);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      await f.cleanup();
    }
  });
  test("a pending Page flush follows rename to the current owner key", async () => {
    const f = await fixture("Pending/README.md", true);
    try {
      let release!: () => void;
      flushBody = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      await clickTab(f.dom, 1);
      await act(async () => {
        publishPageTitleOutcome(
          f.spacePath,
          "Pending/README.md",
          page("Saved/README.md"),
        );
        await settle();
      });
      await act(async () => {
        release();
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      expect(
        f.dom.window.document
          .querySelector("[data-app]")
          ?.getAttribute("data-app"),
      ).toBe("Saved");
      expect(mounts).toBe(1);
    } finally {
      flushBody = async () => {};
      await f.cleanup();
    }
  });

  test("an App render failure stays inside its common surface boundary", async () => {
    const f = await fixture("Broken/README.md", true);
    const previousError = console.error;
    console.error = () => {};
    try {
      const editor = f.dom.window.document.querySelector("textarea");
      appBroken = true;
      await clickTab(f.dom, 1);
      expect(tabs(f.dom).length).toBe(3);
      expect(f.dom.window.document.querySelector("textarea")).toBe(editor);
      await clickTab(f.dom, 2);
      expect(
        f.dom.window.document.querySelector("[data-attachments]") !== null,
      ).toBe(true);
      await clickTab(f.dom, 0);
      expect(f.dom.window.document.querySelector("textarea")).toBe(editor);
      expect(mounts).toBe(1);
    } finally {
      console.error = previousError;
      await f.cleanup();
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
