import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { Column } from "../model/types";

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
  const addedColumns: Column[] = [];
  const server = { refuse: true, columns: [] as Column[] };
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;
  const realSchemaApi = await import("../api/schema-api");

  mock.module("../api/schema-api", () => ({
    ...realSchemaApi,
    addSchemaColumn: async ({ column }: { column: Column }) => {
      addedColumns.push(column);
      if (server.refuse) throw new Error("schema error: backend refused");
      server.columns = [...server.columns, column];
      return { columns: server.columns };
    },
    getPageSchema: async () => ({
      collectionRootPath: "tasks",
      schema: { columns: server.columns },
    }),
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
  const { PropertyAddTypeMenu } = await import("./property-add-type-menu");
  const { PropertyPanel } = await import("./property-panel");
  const { setLocale } = await import("@/paraglide/runtime.js");
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

  test("add-type pane marks nothing and keeps an existing Status and ID unavailable with the reason", () => {
    const render = (columns: typeof withSingletons | []) => {
      const dom = new JSDOM(
        `<!doctype html><body>${renderToStaticMarkup(
          <PropertyTypeMenuPane
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
    const status = blocked.get(m.table_property_type_status())!;
    expect(status.disabled).toBe(false);
    expect(status.getAttribute("aria-disabled")).toBe("true");
    expect(
      status.ownerDocument.getElementById(
        status.getAttribute("aria-describedby")!,
      )?.textContent,
    ).toBe(
      m.property_type_add_unavailable({
        type: m.table_property_type_status(),
      }),
    );
    expect(
      blocked
        .get(m.table_property_type_unique_id())
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      blocked
        .get(m.table_property_type_select())
        ?.hasAttribute("aria-disabled"),
    ).toBe(false);
    expect(
      Array.from(blocked.values()).some(
        (row) =>
          row.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
      ),
    ).toBe(false);

    const open = render([]);
    expect(
      Array.from(open.values()).some((row) =>
        row.hasAttribute("aria-disabled"),
      ),
    ).toBe(false);
  });

  test("the change-type pane marks and disables the current type", () => {
    const dom = new JSDOM(
      `<!doctype html><body>${renderToStaticMarkup(
        <PropertyTypeMenuPane
          activeType="select"
          disableActive
          onSelect={() => undefined}
        />,
      )}</body>`,
    );
    const rows = rowsByLabel(dom.window.document);
    const current = rows.get(m.table_property_type_select())!;
    expect(current.disabled).toBe(true);
    expect(
      current.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
    ).toBe(true);
    expect(
      Array.from(rows.values()).filter(
        (row) =>
          row.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
      ).length,
    ).toBe(1);
  });

  /** Renders a record property panel and returns its add-property action. */
  async function renderPanel({
    columns,
    values = {},
    readOnly = false,
  }: {
    columns: Column[];
    values?: Record<string, unknown>;
    readOnly?: boolean;
  }) {
    server.columns = columns;
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const container = dom.window.document.getElementById("app")!;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PropertyPanel
          mode="full"
          readOnly={readOnly}
          spacePath="/project"
          projectPath="/project"
          filePath="tasks/task.md"
          pageLabel="Task"
          schemaResult={{ collectionRootPath: "tasks", schema: { columns } }}
          values={values}
          onValueChange={async () => undefined}
        />,
      );
      await nextFrame(dom);
    });
    const addButtons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).filter((button) => button.textContent === m.collection_add_property());
    const popover = () =>
      dom.window.document.querySelector<HTMLElement>(
        '[data-slot="popover-content"]',
      );
    return {
      dom,
      container,
      addButtons,
      popover,
      openMenu: async () => {
        await act(async () => {
          addButtons()[0].click();
          await nextFrame(dom);
        });
        return popover()!;
      },
      /** Opens the add menu and picks a type in it. */
      add: async (label: string) => {
        await act(async () => {
          addButtons()[0].click();
          await nextFrame(dom);
        });
        await act(async () => {
          rowButton(popover()!, label).click();
          await nextFrame(dom);
          await nextFrame(dom);
          await nextFrame(dom);
        });
      },
      cleanup: async () => {
        await act(async () => root.unmount());
        restoreGlobals();
        dom.window.close();
      },
    };
  }

  /** Opens the add menu the table + uses, for comparison with the panel. */
  async function openSharedAddMenu(columns: Column[]) {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    await act(async () => {
      root.render(
        <PropertyAddTypeMenu
          trigger={<button type="button">+</button>}
          columns={columns}
          onSelect={() => undefined}
        />,
      );
      await nextFrame(dom);
    });
    await act(async () => {
      dom.window.document.querySelector("button")!.click();
      await nextFrame(dom);
    });
    const menu = readMenu(
      dom.window.document.querySelector<HTMLElement>(
        '[data-slot="popover-content"]',
      )!,
    );
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
    return menu;
  }

  test("the record panel opens the shared add-type list with nothing marked", async () => {
    const columns: Column[] = [
      { name: "Summary", type: "text" },
      ...withSingletons,
    ];
    const shared = await openSharedAddMenu(columns);
    const panel = await renderPanel({ columns });
    try {
      expect(panel.addButtons().length).toBe(1);
      const menu = readMenu(await panel.openMenu());
      expect(menu).toEqual(shared);
      expect(menu.rows.length).toBe(13);
      expect(menu.title).toBe(m.table_property_type_title());
      expect(menu.notice).toBe(m.property_add_type_notice());
      expect(menu.rows.some((item) => item.checked)).toBe(false);
      expect(
        menu.rows.find((item) => item.label === m.table_property_type_status())
          ?.unavailable,
      ).toBe(true);
    } finally {
      await panel.cleanup();
    }
  });

  test("the record panel names a new property after its type and opens its menu with the name focused", async () => {
    setLocale("ru", { reload: false });
    server.refuse = false;
    addedColumns.length = 0;
    const panel = await renderPanel({
      columns: [{ name: "Summary", type: "text" }],
      values: { Summary: "Review" },
    });
    const focusedName = () => {
      const input = panel.dom.window.document
        .activeElement as HTMLInputElement | null;
      return input?.getAttribute("aria-label") === m.property_dialog_name()
        ? input.value
        : null;
    };
    try {
      await panel.add("Текст");
      expect(addedColumns).toEqual([{ name: "Текст", type: "text" }]);
      expect(
        panel.container.querySelector(
          '[data-property-label-trigger="Текст"]',
        ) === null,
      ).toBe(false);
      expect(focusedName()).toBe("Текст");

      await act(async () => {
        panel.dom.window.document.dispatchEvent(
          new panel.dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await nextFrame(panel.dom);
      });
      await panel.add("Текст");
      expect(addedColumns[1]).toEqual({ name: "Текст 2", type: "text" });
      expect(focusedName()).toBe("Текст 2");

      await act(async () => {
        panel.dom.window.document.dispatchEvent(
          new panel.dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await nextFrame(panel.dom);
      });
      await panel.add("Связь");
      expect(addedColumns[2]).toEqual({
        name: "Связь",
        type: "relation",
        relation: "tasks",
      });
    } finally {
      server.refuse = true;
      setLocale("en", { reload: false });
      await panel.cleanup();
    }
  });

  test("a refused add from the property panel shows a localized toast and keeps the schema", async () => {
    toastErrors.length = 0;
    addedColumns.length = 0;
    const originalConsoleError = console.error;
    const consoleErrors: unknown[] = [];
    console.error = (...args: unknown[]) => consoleErrors.push(args);
    const panel = await renderPanel({
      columns: [{ name: "Summary", type: "text" }],
      values: { Summary: "Review" },
    });

    try {
      await panel.add(m.table_property_type_text());

      expect(addedColumns.length).toBe(1);
      expect(toastErrors).toEqual([m.property_add_failed()]);
      expect(consoleErrors.length).toBe(1);
      expect(panel.popover()).toBe(null);
      expect(
        panel.container.querySelectorAll("[data-property-label-trigger]")
          .length,
      ).toBe(1);
    } finally {
      console.error = originalConsoleError;
      await panel.cleanup();
    }
  });

  test("a collection without properties offers only the add action, and none in read-only", async () => {
    const empty = await renderPanel({
      columns: [],
      values: { Legacy: "orphan value" },
    });
    try {
      expect(empty.addButtons().length).toBe(1);
      expect(empty.container.querySelectorAll("button").length).toBe(1);
      expect(empty.container.textContent).toBe(m.collection_add_property());
    } finally {
      await empty.cleanup();
    }

    const readOnly = await renderPanel({ columns: [], readOnly: true });
    try {
      expect(readOnly.container.innerHTML).toBe("");
    } finally {
      await readOnly.cleanup();
    }

    const filled = await renderPanel({
      columns: [{ name: "Summary", type: "text" }],
      readOnly: true,
    });
    try {
      expect(filled.addButtons().length).toBe(0);
    } finally {
      await filled.cleanup();
    }
  });
}

/** Title, type rows and notice of an add-type menu, as the user sees them. */
function readMenu(popover: HTMLElement) {
  const document = popover.ownerDocument;
  const rows = Array.from(
    popover.querySelectorAll<HTMLButtonElement>(".p-1 > button"),
  ).map((button) => {
    const describedBy = button.getAttribute("aria-describedby");
    return {
      label: button.querySelector(".font-medium")?.textContent ?? "",
      className: button.className,
      unavailable: button.getAttribute("aria-disabled") === "true",
      description: describedBy
        ? (document.getElementById(describedBy)?.textContent ?? null)
        : null,
      checked:
        button.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
    };
  });
  return {
    title: popover.querySelector("div.truncate")?.textContent ?? "",
    rows,
    notice: popover.querySelector(".text-xs.text-muted-foreground")
      ?.textContent,
  };
}

function rowButton(popover: HTMLElement, label: string) {
  return Array.from(
    popover.querySelectorAll<HTMLButtonElement>(".p-1 > button"),
  ).find(
    (button) => button.querySelector(".font-medium")?.textContent === label,
  )!;
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
