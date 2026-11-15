import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// The real Page editor in a Page session: a body draft typed in the editor
// when its file disappears outside this window (DF-269 R3). Runs in its own
// process, as other files replace modules the real editor needs.
if (process.env.SVODE_PAGE_GONE_EDITOR_DOM !== "1") {
  test("Page body draft when its file disappears, real editor, isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_PAGE_GONE_EDITOR_DOM: "1" },
      encoding: "utf8",
    });
    expect(child.status, child.stdout + child.stderr).toBe(0);
  }, 120000);
} else {
  const { JSDOM } = await import("jsdom");
  const jsdom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  // The real editor reads DOM classes and the window from the global scope.
  const domGlobals = jsdom.window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(jsdom.window)) {
    if (!/^[A-Z]/.test(key) || key in globalThis) continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: domGlobals[key],
    });
  }
  for (const key of [
    "window",
    "document",
    "navigator",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: jsdom.window[key],
    });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  for (const key of ["ResizeObserver", "IntersectionObserver"] as const) {
    const NoopObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: NoopObserver,
    });
    Object.defineProperty(jsdom.window, key, {
      configurable: true,
      value: NoopObserver,
    });
  }
  jsdom.window.HTMLElement.prototype.scrollIntoView = () => {};
  jsdom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof jsdom.window.matchMedia;
  const { act, useEffect } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { toast } = await import("sonner");
  const { mockNativeIpc, clearNativeMocks } =
    await import("../src/platform/native/testing");
  const { emit } = await import("../src/platform/native/events");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { PageDetailProvider } =
    await import("../src/features/page/hooks/page-detail-context");
  const { PageSurfaceSessionProvider, usePageSurfaceSession } =
    await import("../src/features/page/hooks/page-surface-context");
  const { ReadmeSurface } =
    await import("../src/features/page/ui/readme-surface");
  type Session = ReturnType<typeof usePageSurfaceSession>;

  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      for (let step = 0; step < 8; step += 1) await turn();
    });

  // The Plate editor that renders `editable`, found through its React owners.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function editorOf(editable: Element): any {
    const key = Object.keys(editable).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fiber = key ? (editable as any)[key] : null;
    while (fiber) {
      const editor = fiber.memoizedProps?.editor;
      if (editor?.tf?.insertText) return editor;
      fiber = fiber.return;
    }
    throw new Error("No editor renders the editable");
  }

  async function harness(
    path = "docs/P5.md",
    target: "page" | "readme" = "page",
  ) {
    let ownerGone = false;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const spacePath = `/space-${Math.random()}`;
    const disk = {
      body: "Before\n",
      version: 1,
      present: true,
      /** What writes fail with, as a locked file refuses them. */
      writeError: null as unknown,
    };
    const writes: string[] = [];
    const toasts: string[] = [];
    let gone = 0;
    let session!: Session;
    const missing = () => `File not found: ${path}`;
    mockNativeIpc(
      async (command, args) => {
        const input = args as Record<string, unknown>;
        if (command === "read_page") {
          if (!disk.present || input.path !== path) throw missing();
          return {
            path,
            body: disk.body,
            source_version: `v${disk.version}`,
            meta: {
              title: "P5",
              icon: null,
              created: "",
              updated: "",
              extra: {},
            },
          };
        }
        if (command === "write_page_body") {
          if (!disk.present) throw missing();
          if (disk.writeError) throw disk.writeError;
          if (input.sourceVersion !== `v${disk.version}`)
            throw { kind: "source_stale", message: "stale", path };
          writes.push(String(input.content));
          disk.body = String(input.content);
          disk.version += 1;
          return {
            write_nonce: `n${disk.version}`,
            source_version: `v${disk.version}`,
          };
        }
        if (command === "repository_access_get")
          return {
            checkedAt: null,
            expiresAt: null,
            generation: 1,
            lastKnownStatus: null,
            reason: null,
            repositoryId: spacePath,
            status: "local",
          };
        if (command === "git_status") return { files: [] };
        if (command === "validate_links") return [];
        if (command === "list_content_tree_children") return [];
        if (command === "navigation_expanded_paths") return [];
        return null;
      },
      { shouldMockEvents: true },
    );
    const saved = { warning: toast.warning, error: toast.error };
    toast.warning = ((message: unknown) => {
      toasts.push(String(message));
      return 0;
    }) as typeof toast.warning;
    toast.error = ((message: unknown) => {
      toasts.push(String(message));
      return 0;
    }) as typeof toast.error;

    function Probe() {
      const surfaceSession = usePageSurfaceSession();
      useEffect(() => {
        session = surfaceSession;
      }, [surfaceSession]);
      return null;
    }
    const render = () =>
      act(async () => {
        root.render(
          <TooltipProvider>
            <PageSurfaceSessionProvider
              displayName="P5"
              displayPath={path}
              spacePath={spacePath}
              targetKey={path}
            >
              <PageDetailProvider
                spacePath={spacePath}
                projectPath={spacePath}
                spaceId="root"
                readmePath={path}
                ownerPath={path.replace(/\/readme\.md$/i, "")}
                target={target}
                ownerGone={ownerGone}
                onOpenPath={() => {}}
                onPageGone={() => (gone += 1)}
              >
                <Probe />
                <ReadmeSurface />
              </PageDetailProvider>
            </PageSurfaceSessionProvider>
          </TooltipProvider>,
        );
      });
    await render();
    await wait(200);
    const editable = container.querySelector("[data-slate-editor]");
    if (!editable) throw new Error("The editor did not open");
    const editor = editorOf(editable);

    return {
      disk,
      writes,
      toasts,
      gone: () => gone,
      wait,
      /** The owner resolver confirms the folder of the README owner gone. */
      goneOwner: async () => {
        ownerGone = true;
        await render();
        for (let step = 0; step < 12; step += 1) await act(turn);
      },
      session: () => session,
      type: async (text: string) => {
        await act(async () => {
          editor.tf.insertText(text, { at: editor.api.end([0]) });
          await turn();
        });
      },
      text: () => editable.textContent ?? "",
      event: async (eventPath: string, name: string) => {
        await act(async () => {
          await emit(name, { space: spacePath, path: eventPath });
          for (let step = 0; step < 12; step += 1) await turn();
        });
      },
      cleanup: async () => {
        Object.assign(toast, saved);
        await act(async () => root.unmount());
        container.remove();
        clearNativeMocks();
      },
    };
  }

  test("a body draft in its debounce stays open in the gone state when another writer renames the file itself", async () => {
    const h = await harness();
    try {
      await h.type(" typed");
      h.disk.present = false;
      // FSEvents reports the old path of a renamed file as a modification.
      await h.event("docs/P5.md", "file:changed");
      await wait(1300);
      expect(h.gone()).toBe(0);
      expect(h.session().goneState).toEqual({ pending: false, error: null });
      expect(h.session().sourceConflict).toBeNull();
      expect(h.text()).toContain("typed");
      expect(h.writes).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("a body draft whose autosave fell due after the file went away stays open in the gone state", async () => {
    const h = await harness();
    try {
      await h.type(" typed");
      h.disk.present = false;
      await wait(1300);
      await h.event("docs", "file:deleted");
      await h.event("docs/P5.md", "file:deleted");
      await wait(100);
      expect(h.gone()).toBe(0);
      expect(h.session().goneState).toEqual({ pending: false, error: null });
      expect(h.text()).toContain("typed");
    } finally {
      await h.cleanup();
    }
  });

  test("a body draft whose write is blocked stays open in the gone state when the file disappears", async () => {
    const h = await harness();
    try {
      h.disk.writeError = "Permission denied (os error 1)";
      await h.type(" typed");
      await wait(1300);
      expect(h.session().persistenceError).not.toBeNull();
      h.disk.present = false;
      await h.event("docs/P5.md", "file:changed");
      await wait(100);
      expect(h.gone()).toBe(0);
      expect(h.session().goneState).toEqual({ pending: false, error: null });
      expect(h.session().sourceConflict).toBeNull();
      expect(h.text()).toContain("typed");
    } finally {
      await h.cleanup();
    }
  });

  test("a home page README with a body draft stays open in the gone state when its Collection folder moves out of the Space", async () => {
    const h = await harness("Archive/README.md", "readme");
    try {
      await h.type(" typed");
      h.disk.present = false;
      await h.goneOwner();
      await h.event("Archive", "file:deleted");
      await h.event("Archive/README.md", "file:deleted");
      await h.wait(100);
      expect(h.gone()).toBe(0);
      expect(h.session().goneState).toEqual({ pending: false, error: null });
      expect(h.text()).toContain("typed");
    } finally {
      await h.cleanup();
    }
  });
}
