import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

// DF-237 R4: a `unique_id` number that another item holds is a field error
// of the property panel with "Assign new key".
if (process.env.SVODE_UNIQUE_ID_DUPLICATE_DOM !== "1") {
  test("unique_id duplicate DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_UNIQUE_ID_DUPLICATE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { mockNativeIpc } = await import("@/platform/native/testing");
  const { PropertyPanel } = await import("./property-panel");
  const { validatePropertyValue } = await import("../model/validation");
  const m = await import("@/paraglide/messages.js");
  const doc = dom.window.document;

  const keyColumn = { name: "Key", type: "unique_id" as const, prefix: "T" };
  const schema = { columns: [keyColumn], views: [] };
  const other = { path: "tasks/b.md", title: "From B" };
  const calls: string[] = [];
  mockNativeIpc((command) => {
    calls.push(command);
    if (command === "assign_unique_id") {
      return { meta: { title: "From A", extra: { Key: 8 } } };
    }
    if (command === "get_page_schema") {
      return { schema, collectionRootPath: "tasks" };
    }
    throw new Error(`unexpected command ${command}`);
  });

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  async function hover(element: Element): Promise<string> {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("pointermove", { bubbles: true }),
      );
    });
    await settle();
    return doc.querySelector('[role="tooltip"]')?.textContent ?? "";
  }

  function assignButton() {
    return Array.from(doc.querySelectorAll("button")).find(
      (button) => button.textContent === m.property_action_assign_key(),
    );
  }

  test("a repeated number is a field error that a new key clears", async () => {
    const root = createRoot(doc.getElementById("app")!);
    try {
      await act(async () => {
        root.render(
          <PropertyPanel
            spacePath="/repo"
            projectPath="/repo"
            filePath="tasks/a.md"
            pageLabel="From A"
            schemaResult={{
              collectionRootPath: "tasks",
              schema,
              uniqueIdDuplicate: other,
            }}
            values={{ Key: 3 }}
            onValueChange={async () => undefined}
          />,
        );
      });
      await settle();

      const warning = doc.querySelector("svg.text-warning");
      expect(Boolean(warning)).toBe(true);
      const tooltip = await hover(warning!);
      expect(tooltip.includes(m.property_state_duplicate_key())).toBe(true);
      expect(tooltip.includes("From B")).toBe(true);
      expect(doc.body.textContent?.includes("T-3")).toBe(true);
      expect(Boolean(assignButton())).toBe(true);

      await act(async () => {
        assignButton()!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      await settle();

      expect(calls).toEqual(["assign_unique_id", "get_page_schema"]);
      expect(doc.body.textContent?.includes("T-8")).toBe(true);
      expect(doc.querySelector("svg.text-warning")).toBeNull();
      expect(Boolean(assignButton())).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("only a valid number repeats and other key states stay as they were", () => {
    expect(validatePropertyValue(keyColumn, 3)).toEqual({ invalid: false });
    expect(validatePropertyValue(keyColumn, 3, other)).toEqual({
      invalid: true,
      code: "duplicate_key",
      duplicate: other,
    });
    expect(validatePropertyValue(keyColumn, null, other).code).toBe("no_key");
    expect(validatePropertyValue(keyColumn, "T-3", other).code).toBe(
      "invalid_key",
    );
    expect(
      validatePropertyValue({ ...keyColumn, newer: true }, 3, other),
    ).toEqual({ invalid: false });
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    SVGElement: dom.window.SVGElement,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}
