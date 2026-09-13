import { expect, test, mock } from "bun:test";
import { spawnSync } from "node:child_process";

if (process.env.SVODE_PLATE53_DOM !== "1") {
  test("real ControlledMarkdownEditor DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_PLATE53_DOM: "1" },
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
  for (const key of [
    "window",
    "document",
    "navigator",
    "Node",
    "NodeList",
    "HTMLCollection",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Document",
    "DocumentFragment",
    "MutationObserver",
    "DOMParser",
    "DOMRect",
    "Range",
    "Selection",
    "KeyboardEvent",
    "MouseEvent",
    "Event",
    "CustomEvent",
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
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
  const plate = await import("platejs/react");
  const useActualPlateEditor = plate.usePlateEditor;
  let mountedEditor: ReturnType<typeof plate.usePlateEditor> | undefined;
  mock.module("platejs/react", () => ({
    ...plate,
    usePlateEditor: (...args: Parameters<typeof plate.usePlateEditor>) => {
      const editor = useActualPlateEditor(...args);
      mountedEditor = editor;
      return editor;
    },
  }));
  const { ControlledMarkdownEditor } =
    await import("../src/features/editor/plate/controlled-markdown-editor");
  const { useArtifactSelectionStore } =
    await import("../src/features/artifact/model/selection-store");

  test("Routine editor renders table Page pills, preserves read-only and opens portable Page target", async () => {
    const root = createRoot(document.getElementById("app")!);
    const changes: string[] = [];
    const source =
      "| Header |\\n| --- |\\n| before [Страница](page.md) after |".replaceAll(
        "\\n",
        "\n",
      );
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ControlledMarkdownEditor
              disabled
              value={source}
              onChange={(value) => changes.push(value)}
            />
          </TooltipProvider>,
        );
      });
      expect(document.querySelectorAll("table").length).toBe(1);
      expect(
        document.querySelector("table")?.textContent?.replace(/\s+/g, " "),
      ).toContain("before Страница after");
      expect(changes).toEqual([]);
      expect(
        document
          .querySelector("[data-slate-editor]")
          ?.getAttribute("contenteditable"),
      ).toBe("false");
      const pill = [
        ...document.querySelectorAll("span[data-slate-node='element']"),
      ].find((el) => el.textContent?.trim() === "Страница");
      expect(pill).toBeDefined();
      await act(async () => {
        pill!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(JSON.stringify(useArtifactSelectionStore.getState())).toContain(
        "page.md",
      );
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ControlledMarkdownEditor
              value={source}
              onChange={(value) => changes.push(value)}
            />
          </TooltipProvider>,
        );
      });
      expect(
        document
          .querySelector("[data-slate-editor]")
          ?.getAttribute("contenteditable"),
      ).toBe("true");
      expect(
        document.querySelector("table")?.textContent?.replace(/\s+/g, " "),
      ).toContain("before Страница after");
      expect(changes).toEqual([]);
      await act(async () => {
        mountedEditor!.tf.insertText("edited ", {
          at: { path: [0, 1, 0, 0, 0], offset: 0 },
        });
      });
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.at(-1)).toContain(
        "edited before [Страница](page.md) after",
      );
      const saved = changes.at(-1)!;
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ControlledMarkdownEditor
              key="reopen"
              disabled
              value={saved}
              onChange={(value) => changes.push(value)}
            />
          </TooltipProvider>,
        );
      });
      const writes = changes.length;
      await act(async () => {
        mountedEditor!.tf.insertText("blocked ", {
          at: { path: [0, 1, 0, 0, 0], offset: 0 },
        });
      });
      expect(changes.length).toBe(writes);

      expect(
        document.querySelector("[data-slate-editor]")?.textContent,
      ).toContain("Страница");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
