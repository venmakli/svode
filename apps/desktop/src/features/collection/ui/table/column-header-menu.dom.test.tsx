import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { CollectionSchema } from "@/features/properties";
import type { TableViewProps } from "../../model/table-types";
import type { CollectionView, UseViewQueryResult } from "../../query";

const isolatedProcess =
  process.env.SVODE_COLLECTION_COLUMN_HEADER_MENU_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("collection table column header menu DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_COLLECTION_COLUMN_HEADER_MENU_DOM_PROCESS: "1",
        },
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
  installDomGlobals(createDom());
  const typeChanges: Array<{ columnName: string; newType: string }> = [];
  const deletions: Array<{ columnName: string; deleteValues: boolean }> = [];
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;
  const realPlatform = await import("@/platform/properties/properties-api");

  mock.module("@/platform/properties/properties-api", () => ({
    ...realPlatform,
    changeSchemaType: async (input: {
      columnName: string;
      newType: string;
    }) => {
      typeChanges.push({
        columnName: input.columnName,
        newType: input.newType,
      });
      return {
        schema: {
          columns: schema.columns.map((column) =>
            column.name === input.columnName
              ? { name: column.name, type: input.newType }
              : column,
          ),
        },
        warnings: [],
      };
    },
    deleteSchemaColumn: async (input: {
      columnName: string;
      deleteValues: boolean;
    }) => {
      deletions.push({
        columnName: input.columnName,
        deleteValues: input.deleteValues,
      });
      return {
        columns: schema.columns.filter(
          (column) => column.name !== input.columnName,
        ),
      };
    },
  }));
  const actors = { actors: [], loadActors: async () => [] };
  const tableEntries = {
    get entries() {
      return entries;
    },
    setEntries: () => undefined,
    nestedCollectionPaths: new Set<string>(),
    nestedSchemas: new Map<string, CollectionSchema>(),
    loading: false,
    error: null,
    loadEntries: async () => undefined,
  };
  const entryActions = {
    createEntry: async () => undefined,
    reorderEntries: () => undefined,
  };
  const fieldSave = { commitField: () => undefined };
  mock.module("../../hooks/use-collection-actors", () => ({
    useCollectionActors: () => actors,
  }));
  mock.module("../../hooks/table/use-table-entries", () => ({
    useTableEntries: () => tableEntries,
  }));
  mock.module("../../hooks/table/use-table-entry-actions", () => ({
    useTableEntryActions: () => entryActions,
  }));
  mock.module("../../hooks/use-collection-entry-field-save", () => ({
    useCollectionEntryFieldSave: () => fieldSave,
  }));
  mock.module("sonner", () => ({
    toast: {
      error: () => undefined,
      success: () => undefined,
      warning: () => undefined,
    },
  }));

  const { TableView } = await import("./table-view");
  const { definePageCollectionProperties } =
    await import("../../persisted/page-collection-definition");
  const m = await import("@/paraglide/messages.js");

  const schema: CollectionSchema = {
    columns: [
      { name: "Note", type: "text" },
      {
        name: "Stage",
        type: "select",
        options: [{ name: "Todo", color: "gray" }],
      },
    ],
  };
  const entries: Page[] = ["one", "two"].map((name) => ({
    meta: {
      title: name,
      icon: null,
      created: "",
      updated: "",
      extra: { Note: `${name} note`, Stage: "Todo" },
    },
    body: "",
    path: `tasks/${name}.md`,
  }));
  const view = {
    name: "Table",
    type: "table",
    visible_fields: ["title", "Note", "Stage"],
  } as CollectionView;
  const query = {
    merged: { filter: [], sort: [] },
    setLocalQuery: () => undefined,
  } as unknown as UseViewQueryResult;

  function tableProps(nextSchema: CollectionSchema): TableViewProps {
    return {
      readOnly: false,
      name: "Table",
      view,
      query,
      schema: nextSchema,
      properties: definePageCollectionProperties(nextSchema),
      collectionPath: "tasks",
      spacePath: "/project",
      projectPath: "/project",
      searchQuery: "",
      filters: [],
      sort: [],
      refreshToken: 0,
      onActivateItem: () => undefined,
      onOpenNestedCollection: () => undefined,
      onOpenPath: () => undefined,
      onOpenRelationTarget: () => undefined,
      onSchemaChange: () => undefined,
      onUpdateView: async () => undefined,
      onCreatePage: async () => {
        throw new Error("unused");
      },
    };
  }

  async function withTable(
    run: (context: { dom: JSDOM; root: Root }) => Promise<void>,
  ) {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    try {
      await act(async () => {
        root.render(<TableView {...tableProps(schema)} />);
        await nextFrame(dom);
      });
      await run({ dom, root });
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      restoreGlobals();
      dom.window.close();
    }
  }

  test("choosing a type in the column menu opens the change type dialog", async () => {
    await withTable(async ({ dom }) => {
      for (const action of ["cancel", "save"] as const) {
        typeChanges.length = 0;
        await click(dom, columnHeader(dom, "Note"));
        await click(dom, popoverButton(dom, m.table_column_type()));
        await click(dom, popoverButton(dom, m.table_property_type_select()));

        expect(popover(dom)).toBeNull();
        const dialog =
          dom.window.document.querySelector<HTMLElement>('[role="dialog"]');
        expect(
          dialog?.textContent?.includes(m.property_dialog_change_type_title()),
        ).toBe(true);
        expect(
          dialog?.querySelector('[data-slot="select-value"]')?.textContent,
        ).toBe("Select");

        await click(
          dom,
          dialogButton(
            dom,
            action === "save" ? m.settings_save() : m.project_cancel(),
          ),
        );
        expect(typeChanges).toEqual(
          action === "save" ? [{ columnName: "Note", newType: "select" }] : [],
        );
        expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
      }
    });
  });

  test("deleting from the column menu asks for confirmation", async () => {
    await withTable(async ({ dom }) => {
      for (const action of ["cancel", "confirm"] as const) {
        deletions.length = 0;
        await click(dom, columnHeader(dom, "Note"));
        await click(dom, popoverButton(dom, m.table_delete_column()));

        const dialog = dom.window.document.querySelector<HTMLElement>(
          '[role="alertdialog"]',
        );
        expect(
          dialog?.textContent?.includes(
            m.property_dialog_delete_column_title(),
          ),
        ).toBe(true);

        await click(
          dom,
          dialogButton(
            dom,
            action === "confirm"
              ? m.table_delete_column()
              : m.settings_cancel(),
          ),
        );
        expect(deletions).toEqual(
          action === "confirm"
            ? [{ columnName: "Note", deleteValues: false }]
            : [],
        );
        expect(
          dom.window.document.querySelector('[role="alertdialog"]'),
        ).toBeNull();
      }
    });
  });

  test("an open column menu keeps its pane and header across column recomputes", async () => {
    await withTable(async ({ dom, root }) => {
      const header = columnHeader(dom, "Stage");
      await click(dom, header);
      await click(dom, popoverButton(dom, m.table_type_settings_options()));
      expect(popoverTitle(dom)).toBe(m.table_type_settings());

      const nextSchema: CollectionSchema = {
        columns: schema.columns.map((column) =>
          column.name === "Stage"
            ? {
                ...column,
                options: [
                  ...(column.options ?? []),
                  { name: "Done", color: "green" },
                ],
              }
            : column,
        ),
      };
      await act(async () => {
        root.render(<TableView {...tableProps(nextSchema)} />);
        await nextFrame(dom);
      });

      expect(columnHeader(dom, "Stage") === header).toBe(true);
      expect(header.isConnected).toBe(true);
      expect(popoverTitle(dom)).toBe(m.table_type_settings());
      expect(
        Array.from(
          popover(dom)?.querySelectorAll<HTMLInputElement>("input") ?? [],
        ).map((input) => input.value),
      ).toEqual(["Todo", "Done"]);
    });
  });
}

function columnHeader(dom: JSDOM, label: string) {
  const header = Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>("th button"),
  ).find((button) => button.textContent === label);
  if (!header) throw new Error(`Missing column header ${label}`);
  return header;
}

function popover(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLElement>(
    '[data-slot="popover-content"]',
  );
}

function popoverTitle(dom: JSDOM) {
  return popover(dom)?.querySelector(".truncate.text-sm.font-medium")
    ?.textContent;
}

function popoverButton(dom: JSDOM, label: string) {
  const button = Array.from(
    popover(dom)?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((candidate) => candidate.textContent?.startsWith(label));
  if (!button) throw new Error(`Missing menu row ${label}`);
  return button;
}

function dialogButton(dom: JSDOM, label: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button, [role="alertdialog"] button',
    ),
  ).find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing dialog button ${label}`);
  return button;
}

async function click(dom: JSDOM, element: HTMLElement) {
  await act(async () => {
    element.focus();
    element.click();
    await nextFrame(dom);
    await nextFrame(dom);
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
