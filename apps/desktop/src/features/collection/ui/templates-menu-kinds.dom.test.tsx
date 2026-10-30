import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { TemplateInfo, TemplateKind } from "../model";

const isolatedProcess = process.env.SVODE_TEMPLATES_MENU_KINDS_DOM === "1";

if (!isolatedProcess) {
  test("Collection templates menu kinds DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TEMPLATES_MENU_KINDS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  // Radix picks its layout effect by the presence of `document` at import.
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  installDomGlobals(dom);

  const { createRoot } = await import("react-dom/client");
  const { TemplatesSplitButton } = await import("./templates-menu");
  const m = await import("@/paraglide/messages.js");

  const templates: TemplateInfo[] = [
    { slug: "note", kind: "leaf", title: "Note" },
    { slug: "kickoff", kind: "folder", title: "Kickoff" },
    { slug: "board", kind: "nestedCollection", title: "Board" },
  ];

  async function renderMenu() {
    const created: TemplateKind[] = [];
    const root = createRoot(dom.window.document.getElementById("app")!);
    await act(async () => {
      root.render(
        <TemplatesSplitButton
          schema={{ columns: [] }}
          onPrimaryCreate={() => undefined}
          onLoadTemplates={async () => templates}
          onCreateTemplate={async (kind) => {
            created.push(kind);
          }}
          onInstantiateTemplate={async () => undefined}
          onEditTemplate={async () => undefined}
          onSetDefaultTemplate={async () => undefined}
          onDuplicateTemplate={async () => undefined}
          onDeleteTemplate={async () => undefined}
          onReorderTemplates={async () => undefined}
        />,
      );
      await nextFrame(dom);
    });
    const document = dom.window.document;
    const click = async (element: HTMLElement) => {
      await act(async () => {
        element.click();
        await nextFrame(dom);
        await nextFrame(dom);
      });
    };
    const popover = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    const button = (container: ParentNode, text: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.textContent?.includes(text),
      );
    await click(
      document.querySelector<HTMLElement>(
        `button[aria-label="${m.collection_templates()}"]`,
      )!,
    );
    return {
      button,
      click,
      created,
      popover,
      cleanup: async () => {
        await act(async () => {
          root.unmount();
          await nextFrame(dom);
        });
      },
    };
  }

  test("a folder-form template row shows the page icon of a leaf", async () => {
    const ui = await renderMenu();
    try {
      const icon = (title: string) =>
        ui.button(ui.popover()!, title)!.querySelector("svg")!;
      expect(icon("Kickoff").classList.contains("lucide-file-text")).toBe(true);
      expect(icon("Note").classList.contains("lucide-file-text")).toBe(true);
      expect(icon("Board").classList.contains("lucide-database")).toBe(true);
      expect(ui.popover()!.querySelector(".lucide-folder-open")).toBeNull();
    } finally {
      await ui.cleanup();
    }
  });

  test("New template offers Page and Nested collection only", async () => {
    const ui = await renderMenu();
    try {
      await ui.click(ui.button(ui.popover()!, m.collection_new_template())!);
      const pane = ui.popover()!;
      const rows = Array.from(
        pane.querySelectorAll<HTMLButtonElement>(".p-1 > button"),
      ).map((row) => row.textContent);
      expect(rows).toEqual([
        m.collection_template_type_leaf(),
        m.collection_template_type_nested_collection(),
      ]);
      expect(pane.querySelector(".lucide-folder-open")).toBeNull();

      await ui.click(ui.button(pane, m.collection_template_type_leaf())!);
      expect(ui.created).toEqual(["leaf"]);
    } finally {
      await ui.cleanup();
    }
  });
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
  for (const [key, value] of Object.entries({
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
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
