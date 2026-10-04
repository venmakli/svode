import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

if (process.env.SVODE_EDITOR_TOC_DOM !== "1") {
  test("real Page editor TOC DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_EDITOR_TOC_DOM: "1" },
      encoding: "utf8",
    });
    expect(child.status, child.stdout + child.stderr).toBe(0);
  }, 30000);
} else {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const domGlobals = dom.window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(dom.window)) {
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
  ] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const key of ["ResizeObserver", "IntersectionObserver"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: NoopObserver,
    });
    Object.defineProperty(dom.window, key, {
      configurable: true,
      value: NoopObserver,
    });
  }
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    media: "",
    onchange: null,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { mockNativeIpc } = await import("../src/platform/native/testing");
  const { PlateDocumentEditor } =
    await import("../src/features/editor/plate/plate-editor");

  test("Page editor shows the TOC for headings of a freshly opened Page", async () => {
    const meta = { title: "Goal" } as never;
    const page = {
      meta,
      body: "## Focus\n\nFirst.\n\n## Key Results\n\nSecond.\n",
      path: "goal.md",
      source_version: "v1",
    };
    mockNativeIpc((cmd) => {
      if (cmd === "read_page") return page;
      if (cmd === "validate_links") return [];
      return null;
    });
    const root = createRoot(document.getElementById("app")!);
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <PlateDocumentEditor
              bodyOnly
              pageScroll
              documentPath={page.path}
              documentSpaceId="space"
              spacePath="/space"
              projectPath="/space"
              bodyOnlyMeta={meta}
              initialPage={page as never}
              initialPageSpacePath="/space"
            />
          </TooltipProvider>,
        );
      });
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      expect(
        document.querySelector("[data-slate-editor]")?.textContent,
      ).toContain("Key Results");
      expect(document.querySelectorAll("nav button").length).toBe(2);
    } finally {
      await act(async () => root.unmount());
    }
  });
}
