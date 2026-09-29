import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const isolatedProcess = process.env.SVODE_ADD_PROPERTY_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("add property DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ADD_PROPERTY_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  // Radix picks its layout effect by the presence of `document` at import.
  installDomGlobals(createDom());
  const toastErrors: unknown[] = [];
  const addedColumns: unknown[] = [];
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;
  const realSchemaApi = await import("../api/schema-api");

  mock.module("../api/schema-api", () => ({
    ...realSchemaApi,
    addSchemaColumn: async ({ column }: { column: unknown }) => {
      addedColumns.push(column);
      throw new Error("schema error: backend refused");
    },
  }));
  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toastErrors.push(message),
      success: () => undefined,
      warning: () => undefined,
    },
  }));

  const { isPropertyTypeAddable } = await import("../model/add-column");
  const { PropertyTypeMenuPane } = await import("./schema-column-menu");
  const { propertyTypeAddUnavailableReason } =
    await import("./property-type-meta");
  const { AddColumnDialog } = await import("./column-schema-dialogs");
  const { PropertyPanel } = await import("./property-panel");
  const m = await import("@/paraglide/messages.js");

  const withSingletons = [
    { name: "Stage", type: "status" as const },
    { name: "Key", type: "unique_id" as const },
  ];

  test("only a second Status or ID cannot be added", () => {
    expect(isPropertyTypeAddable([], "status")).toBe(true);
    expect(isPropertyTypeAddable([], "unique_id")).toBe(true);
    expect(isPropertyTypeAddable(withSingletons, "status")).toBe(false);
    expect(isPropertyTypeAddable(withSingletons, "unique_id")).toBe(false);
    expect(isPropertyTypeAddable(withSingletons, "select")).toBe(true);
    expect(isPropertyTypeAddable(withSingletons, "multi_select")).toBe(true);
    expect(propertyTypeAddUnavailableReason(withSingletons, "status")).toBe(
      m.property_type_add_unavailable({
        type: m.table_property_type_status(),
      }),
    );
  });

  test("add-type pane disables an existing Status and ID with the reason", () => {
    const render = (columns: typeof withSingletons | []) => {
      const dom = new JSDOM(
        `<!doctype html><body>${renderToStaticMarkup(
          <PropertyTypeMenuPane
            activeType="text"
            unavailableReason={(type) =>
              propertyTypeAddUnavailableReason(columns, type)
            }
            onSelect={() => undefined}
          />,
        )}</body>`,
      );
      return rowsByLabel(dom.window.document);
    };

    const blocked = render(withSingletons);
    expect(blocked.get(m.table_property_type_status())?.disabled).toBe(true);
    expect(blocked.get(m.table_property_type_unique_id())?.disabled).toBe(true);
    expect(
      blocked.get(m.table_property_type_status())?.textContent?.includes(
        m.property_type_add_unavailable({
          type: m.table_property_type_status(),
        }),
      ),
    ).toBe(true);
    expect(blocked.get(m.table_property_type_select())?.disabled).toBe(false);
    expect(blocked.get(m.table_property_type_multi_select())?.disabled).toBe(
      false,
    );

    const open = render([]);
    expect(open.get(m.table_property_type_status())?.disabled).toBe(false);
    expect(open.get(m.table_property_type_unique_id())?.disabled).toBe(false);
  });

  test("add field dialog disables an existing Status and ID", async () => {
    const render = async (columns: typeof withSingletons | []) => {
      const dom = createDom();
      const restoreGlobals = installDomGlobals(dom);
      const root = createRoot(dom.window.document.getElementById("app")!);
      try {
        await act(async () => {
          root.render(
            <AddColumnDialog
              open
              onOpenChange={() => undefined}
              columns={columns}
              onSubmit={async () => undefined}
            />,
          );
          await nextFrame(dom);
        });
        await act(async () => {
          dom.window.document
            .getElementById("property-column-type")!
            .dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
              }),
            );
          await nextFrame(dom);
        });
        return Array.from(
          dom.window.document.querySelectorAll<HTMLElement>('[role="option"]'),
        ).map((option) => ({
          text: option.textContent ?? "",
          disabled: option.hasAttribute("data-disabled"),
        }));
      } finally {
        await act(async () => root.unmount());
        restoreGlobals();
        dom.window.close();
      }
    };
    const byLabel = (
      options: { text: string; disabled: boolean }[],
      label: string,
    ) => options.find((option) => option.text.startsWith(label))!;
    const statusReason = m.property_type_add_unavailable({
      type: m.table_property_type_status(),
    });

    const blocked = await render(withSingletons);
    expect(blocked.length).toBe(13);
    expect(byLabel(blocked, m.table_property_type_status())).toEqual({
      text: `${m.table_property_type_status()}${statusReason}`,
      disabled: true,
    });
    expect(byLabel(blocked, m.table_property_type_unique_id()).disabled).toBe(
      true,
    );
    expect(
      blocked.find((option) => option.text === m.table_property_type_select())
        ?.disabled,
    ).toBe(false);
    expect(
      blocked.find(
        (option) => option.text === m.table_property_type_multi_select(),
      )?.disabled,
    ).toBe(false);

    const open = await render([]);
    expect(open.length).toBe(13);
    expect(open.some((option) => option.disabled)).toBe(false);
  });

  test("a refused add from the property panel shows a localized toast and keeps the dialog", async () => {
    toastErrors.length = 0;
    addedColumns.length = 0;
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const originalConsoleError = console.error;
    const consoleErrors: unknown[] = [];
    console.error = (...args: unknown[]) => consoleErrors.push(args);

    try {
      await act(async () => {
        root.render(
          <PropertyPanel
            mode="full"
            spacePath="/project"
            projectPath="/project"
            filePath="tasks/task.md"
            pageLabel="Task"
            schemaResult={{
              collectionRootPath: "tasks",
              schema: { columns: [{ name: "Summary", type: "text" }] },
            }}
            values={{ Summary: "Review" }}
            onValueChange={async () => undefined}
          />,
        );
        await nextFrame(dom);
      });

      const addField = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) => button.textContent === m.editor_frontmatter_add_field(),
      )!;
      await act(async () => {
        addField.click();
        await nextFrame(dom);
      });

      const nameInput = dom.window.document.getElementById(
        "property-column-name",
      ) as HTMLInputElement;
      await act(async () => {
        setInputValue(dom, nameInput, "Priority");
        await nextFrame(dom);
      });
      const submit = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ).find((button) => button.textContent === m.editor_frontmatter_add())!;
      await act(async () => {
        submit.click();
        await nextFrame(dom);
        await nextFrame(dom);
      });

      expect(addedColumns.length).toBe(1);
      expect(toastErrors).toEqual([m.property_add_failed()]);
      expect(consoleErrors.length).toBe(1);
      expect(
        dom.window.document.getElementById("property-column-name") === null,
      ).toBe(false);
      expect(
        dom.window.document.querySelectorAll("[data-property-label-trigger]")
          .length,
      ).toBe(1);
    } finally {
      console.error = originalConsoleError;
      await act(async () => root.unmount());
      restoreGlobals();
      dom.window.close();
    }
  });
}

function rowsByLabel(document: Document) {
  const rows = new Map<string, HTMLButtonElement>();
  for (const button of Array.from(document.querySelectorAll("button"))) {
    const label =
      button.querySelector(".font-medium")?.textContent ?? button.textContent;
    if (label) rows.set(label, button);
  }
  return rows;
}

function setInputValue(dom: JSDOM, input: HTMLInputElement, value: string) {
  // React watches value changes of the focused text input in this DOM.
  input.focus();
  Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const propertyChange = new dom.window.Event("propertychange", {
    bubbles: true,
  });
  Object.defineProperty(propertyChange, "propertyName", { value: "value" });
  input.dispatchEvent(propertyChange);
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
