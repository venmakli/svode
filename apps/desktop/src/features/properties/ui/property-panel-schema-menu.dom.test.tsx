import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const isolatedProcess =
  process.env.SVODE_PROPERTY_PANEL_MENU_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("property panel schema menu DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PROPERTY_PANEL_MENU_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  test("Page labels own schema menus while values and Table actions stay separate", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const { PropertyPanel } = await import("./property-panel");
    const { PropertyLabelTrigger, SchemaColumnMenu } =
      await import("./schema-column-menu");
    const m = await import("@/paraglide/messages.js");
    const panel = (mode: "full" | "peek") => (
      <PropertyPanel
        mode={mode}
        spacePath="/project"
        projectPath="/project"
        filePath="tasks/task.md"
        entryLabel="Task"
        schemaResult={{
          collectionRootPath: "tasks",
          schema: {
            columns: [
              { name: "Summary", type: "text" },
              { name: "Published", type: "boolean", display: "switch" },
              { name: "Contact", type: "email" },
            ],
          },
        }}
        values={{
          Summary: "Review",
          Published: false,
          Contact: "invalid",
          Legacy: "kept",
        }}
        onValueChange={async () => undefined}
      />
    );

    try {
      await act(async () => {
        root.render(panel("full"));
        await nextFrame(dom);
        await nextFrame(dom);
      });

      const triggers = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[data-property-label-trigger]",
        ),
      );
      expect(triggers.length).toBe(3);
      expect(triggers.map((trigger) => trigger.dataset.propertyType)).toEqual([
        "text",
        "boolean",
        "email",
      ]);
      expect(
        triggers.every((trigger) => trigger.querySelector("svg") !== null),
      ).toBe(true);
      expect(
        triggers[1]!.getAttribute("aria-label")?.includes("Published"),
      ).toBe(true);
      expect(
        triggers[1]!
          .getAttribute("aria-label")
          ?.includes(m.table_property_type_boolean()),
      ).toBe(true);
      expect(
        dom.window.document.querySelector(
          '[data-property-label-trigger="Legacy"]',
        ),
      ).toBeNull();
      expect(
        dom.window.document
          .querySelector('[data-property-label-trigger="Contact"]')
          ?.parentElement?.parentElement?.querySelector(".text-warning") !==
          null,
      ).toBe(true);

      const grid = triggers[0]!.closest(".grid")!;
      expect(grid.className.includes("_auto")).toBe(false);
      expect(grid.className.includes("md:grid-cols-")).toBe(true);

      const publishedTrigger = triggers[1]!;
      const publishedRow = publishedTrigger.closest(".contents")!;
      const valueTrigger =
        publishedRow.children[1]!.querySelector<HTMLElement>(
          '[role="button"]',
        )!;
      expect(valueTrigger === publishedTrigger).toBe(false);
      await act(async () => {
        valueTrigger.click();
        await nextFrame(dom);
      });
      expect(
        dom.window.document.querySelector('[data-slot="popover-content"]'),
      ).toBeNull();
      expect(
        publishedRow.querySelector(
          '[role="switch"][aria-label="Published: Task"]',
        ) !== null,
      ).toBe(true);

      await act(async () => {
        root.render(panel("peek"));
        await nextFrame(dom);
      });
      const peekGrid = dom.window.document
        .querySelector('[data-property-label-trigger="Summary"]')!
        .closest(".grid")!;
      expect(peekGrid.className.includes("_auto")).toBe(false);
      expect(peekGrid.className.includes("md:grid-cols-")).toBe(false);

      const menuColumn = {
        name: "Published",
        type: "boolean" as const,
        display: "switch" as const,
      };
      function MenuHarness() {
        const [open, setOpen] = useState(false);
        return (
          <SchemaColumnMenu
            trigger={<PropertyLabelTrigger column={menuColumn} open={open} />}
            open={open}
            column={menuColumn}
            schema={{ columns: [menuColumn] }}
            collectionPath="tasks"
            spacePath="/project"
            projectPath="/project"
            onOpenChange={setOpen}
            onSchemaChange={() => undefined}
          />
        );
      }
      await act(async () => {
        root.render(<MenuHarness />);
        await nextFrame(dom);
      });
      const menuTrigger = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-property-label-trigger="Published"]',
      )!;
      await act(async () => {
        menuTrigger.focus();
        menuTrigger.click();
        await nextFrame(dom);
      });
      const popover = dom.window.document.querySelector<HTMLElement>(
        '[data-slot="popover-content"]',
      )!;
      expect(menuTrigger.tagName).toBe("BUTTON");
      expect(menuTrigger.getAttribute("aria-haspopup")).toBe("dialog");
      expect(popover !== null).toBe(true);
      expect(popover.textContent.includes(m.table_column_type())).toBe(true);
      expect(
        popover.textContent.includes(m.table_type_settings_boolean()),
      ).toBe(true);
      expect(popover.textContent.includes(m.table_duplicate_column())).toBe(
        true,
      );
      expect(popover.textContent.includes(m.table_delete_column())).toBe(true);
      expect(popover.textContent.includes(m.table_hide_column())).toBe(false);
      expect(popover.textContent.includes(m.table_filter())).toBe(false);
      expect(popover.textContent.includes(m.view_query_sort_title())).toBe(
        false,
      );

      const typeRow = Array.from(
        popover.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.includes(m.table_column_type()))!;
      await act(async () => {
        typeRow.click();
        await nextFrame(dom);
      });
      expect(
        dom.window.document.querySelector(
          '[data-slot="popover-content"] input',
        ),
      ).toBeNull();

      await act(async () => {
        menuTrigger.click();
        await nextFrame(dom);
        menuTrigger.click();
        await nextFrame(dom);
      });
      expect(
        dom.window.document.querySelector(
          '[data-slot="popover-content"] input',
        ) !== null,
      ).toBe(true);

      const menuInput = dom.window.document.querySelector<HTMLInputElement>(
        '[data-slot="popover-content"] input',
      )!;
      await act(async () => {
        menuInput.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextFrame(dom);
      });
      expect(
        dom.window.document.querySelector('[data-slot="popover-content"]'),
      ).toBeNull();
      expect(dom.window.document.activeElement === menuTrigger).toBe(true);

      for (const key of ["Enter", " "]) {
        await act(async () => {
          activateButtonWithKeyboard(dom, menuTrigger, key);
          await nextFrame(dom);
        });
        expect(
          dom.window.document.querySelectorAll('[data-slot="popover-content"]')
            .length,
        ).toBe(1);
        await act(async () => {
          dom.window.document
            .querySelector<HTMLElement>('[data-slot="popover-content"]')!
            .dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "Escape",
              }),
            );
          await nextFrame(dom);
        });
      }
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      restoreGlobals();
      dom.window.close();
    }
  });
}

function activateButtonWithKeyboard(
  dom: JSDOM,
  button: HTMLButtonElement,
  key: string,
) {
  button.focus();
  const keyDown = new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  button.dispatchEvent(keyDown);
  if (!keyDown.defaultPrevented) button.click();
  button.dispatchEvent(
    new dom.window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      key,
    }),
  );
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
