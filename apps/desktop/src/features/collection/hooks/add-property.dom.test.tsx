import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { CollectionSchema } from "@/features/properties";
import type { TableViewProps } from "../model/table-types";
import type { CollectionView, UseViewQueryResult } from "../query";
import type { SettingsPane } from "../model";

const isolatedProcess =
  process.env.SVODE_COLLECTION_ADD_PROPERTY_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("collection add property DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_COLLECTION_ADD_PROPERTY_DOM_PROCESS: "1",
        },
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
  const realApi = await import("../api");

  mock.module("../api", () => ({
    ...realApi,
    addCollectionColumn: async ({ column }: { column: unknown }) => {
      addedColumns.push(column);
      throw new Error("schema error: backend refused");
    },
  }));
  mock.module("./use-collection-actors", () => ({
    useCollectionActors: () => ({ actors: [], loadActors: async () => [] }),
  }));
  mock.module("./table/use-table-entries", () => ({
    useTableEntries: () => ({
      entries: [],
      setEntries: () => undefined,
      nestedCollectionPaths: new Set<string>(),
      nestedSchemas: new Map<string, CollectionSchema>(),
      loading: false,
      error: null,
      loadEntries: async () => undefined,
    }),
  }));
  mock.module("./table/use-table-entry-actions", () => ({
    useTableEntryActions: () => ({
      createEntry: async () => undefined,
      reorderEntries: () => undefined,
    }),
  }));
  mock.module("./use-collection-entry-field-save", () => ({
    useCollectionEntryFieldSave: () => ({ commitField: () => undefined }),
  }));
  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toastErrors.push(message),
      success: () => undefined,
      warning: () => undefined,
    },
  }));

  const { PropertyTypePicker } =
    await import("../ui/table/property-type-picker");
  const { ViewSettingsPropertyAddTypePane } =
    await import("../ui/view-settings/properties-pane");
  const { useTableViewRuntime } =
    await import("./table/use-table-view-runtime");
  const { useViewSettingsActions } =
    await import("./use-view-settings-actions");
  const m = await import("@/paraglide/messages.js");

  const withSingletons: CollectionSchema = {
    columns: [
      { name: "Summary", type: "text" },
      { name: "Stage", type: "status" },
      { name: "Key", type: "unique_id" },
    ],
  };
  const statusReason = m.property_type_add_unavailable({
    type: m.table_property_type_status(),
  });

  test("the table + menu disables an existing Status and ID with the reason", async () => {
    const render = async (schema: CollectionSchema) => {
      const dom = createDom();
      const restoreGlobals = installDomGlobals(dom);
      const root = createRoot(dom.window.document.getElementById("app")!);
      try {
        await act(async () => {
          root.render(
            <PropertyTypePicker
              trigger={<button type="button" data-add-property />}
              columns={schema.columns}
              onSelect={() => undefined}
            />,
          );
        });
        await act(async () => {
          dom.window.document
            .querySelector<HTMLButtonElement>("[data-add-property]")!
            .click();
          await nextFrame(dom);
        });
        return typeRows(
          dom.window.document.querySelector('[data-slot="popover-content"]')!,
        );
      } finally {
        await act(async () => root.unmount());
        restoreGlobals();
        dom.window.close();
      }
    };

    const blocked = await render(withSingletons);
    expect(blocked.length).toBe(13);
    expect(row(blocked, m.table_property_type_status())).toEqual({
      text: `${m.table_property_type_status()}${statusReason}`,
      disabled: true,
    });
    expect(row(blocked, m.table_property_type_unique_id()).disabled).toBe(true);
    expect(row(blocked, m.table_property_type_select()).disabled).toBe(false);
    expect(row(blocked, m.table_property_type_multi_select()).disabled).toBe(
      false,
    );

    const open = await render({ columns: [{ name: "Summary", type: "text" }] });
    expect(open.some((item) => item.disabled)).toBe(false);
  });

  test("the view settings add-type pane disables an existing Status and ID", () => {
    const render = (schema: CollectionSchema) =>
      typeRows(
        new JSDOM(
          `<!doctype html><body>${renderToStaticMarkup(
            <ViewSettingsPropertyAddTypePane
              schema={schema}
              addColumnWithType={async () => undefined}
            />,
          )}</body>`,
        ).window.document.body,
      );

    const blocked = render(withSingletons);
    expect(row(blocked, m.table_property_type_status())).toEqual({
      text: `${m.table_property_type_status()}${statusReason}`,
      disabled: true,
    });
    expect(row(blocked, m.table_property_type_unique_id()).disabled).toBe(true);
    expect(row(blocked, m.table_property_type_select()).disabled).toBe(false);

    const open = render({ columns: [] });
    expect(open.length).toBe(13);
    expect(open.some((item) => item.disabled)).toBe(false);
  });

  test("a refused add from the table + shows a localized toast and resolves", async () => {
    toastErrors.length = 0;
    addedColumns.length = 0;
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const consoleErrors = silenceConsoleErrors();
    const viewPatches: unknown[] = [];
    const schemaChanges: unknown[] = [];
    let runtime: ReturnType<typeof useTableViewRuntime> | null = null;

    function Harness() {
      const props: Partial<TableViewProps> = {
        name: "Table",
        view: { name: "Table", type: "table" } as CollectionView,
        schema: { columns: [{ name: "Summary", type: "text" }] },
        collectionPath: "tasks",
        spacePath: "/project",
        projectPath: "/project",
        searchQuery: "",
        filters: [],
        sort: [],
        refreshToken: 0,
        onSchemaChange: (schema) => schemaChanges.push(schema),
        onUpdateView: async (_name, patch) => {
          viewPatches.push(patch);
        },
        onCreatePage: async () => {
          throw new Error("unused");
        },
      };
      const current = useTableViewRuntime(props as TableViewProps);
      useEffect(() => {
        runtime = current;
      });
      return null;
    }

    try {
      await act(async () => root.render(<Harness />));
      // A rejected promise would fail this act.
      await act(async () => {
        await runtime!.handleAddColumn("select");
      });

      expect(addedColumns.length).toBe(1);
      expect(toastErrors).toEqual([m.property_add_failed()]);
      expect(consoleErrors.length).toBe(1);
      expect(schemaChanges.length).toBe(0);
      expect(viewPatches.length).toBe(0);
      expect(runtime!.openColumn).toBeNull();
    } finally {
      consoleErrors.restore();
      await act(async () => root.unmount());
      restoreGlobals();
      dom.window.close();
    }
  });

  test("a refused add from view settings shows a localized toast and stays on the type pane", async () => {
    toastErrors.length = 0;
    addedColumns.length = 0;
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const consoleErrors = silenceConsoleErrors();
    const panes: SettingsPane[] = [];
    const viewPatches: unknown[] = [];
    const schemaChanges: unknown[] = [];
    let actions: ReturnType<typeof useViewSettingsActions> | null = null;

    function Harness() {
      const current = useViewSettingsActions({
        view: { name: "Table", type: "table" },
        schema: { columns: [{ name: "Summary", type: "text" }] },
        query: {
          merged: { filter: [], sort: [] },
          setLocalQuery: () => undefined,
        } as unknown as UseViewQueryResult,
        collectionPath: "tasks",
        spacePath: "/project",
        projectPath: "/project",
        savedFields: ["title", "Summary"],
        visibleFieldKey: "visible_fields",
        systemFieldIds: ["title"],
        onOpenChange: () => undefined,
        onPaneChange: (pane) => panes.push(pane),
        onUpdateView: async (_name, patch) => {
          viewPatches.push(patch);
        },
        onSchemaChange: (schema) => schemaChanges.push(schema),
      });
      useEffect(() => {
        actions = current;
      });
      return null;
    }

    try {
      await act(async () => root.render(<Harness />));
      // A rejected promise would fail this act.
      await act(async () => {
        await actions!.addColumnWithType("multi_select");
      });

      expect(addedColumns.length).toBe(1);
      expect(toastErrors).toEqual([m.property_add_failed()]);
      expect(consoleErrors.length).toBe(1);
      expect(schemaChanges.length).toBe(0);
      expect(viewPatches.length).toBe(0);
      expect(panes.includes("propertyEdit")).toBe(false);
    } finally {
      consoleErrors.restore();
      await act(async () => root.unmount());
      restoreGlobals();
      dom.window.close();
    }
  });
}

function typeRows(container: Element) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(".p-1 > button"),
  ).map((button) => ({
    text: button.textContent ?? "",
    disabled: button.disabled,
  }));
}

function row(rows: { text: string; disabled: boolean }[], label: string) {
  return rows.find(
    (item) => item.text === label || item.text.startsWith(label),
  )!;
}

function silenceConsoleErrors() {
  const original = console.error;
  const calls: unknown[] = [];
  console.error = (...args: unknown[]) => calls.push(args);
  return Object.assign(calls, {
    restore: () => {
      console.error = original;
    },
  });
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
    localStorage: dom.window.localStorage,
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
