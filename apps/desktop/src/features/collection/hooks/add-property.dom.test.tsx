import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { JSDOM } from "jsdom";
import type { CollectionSchema, Column } from "@/features/properties";
import type { TableViewProps } from "../model/table-types";
import type { CollectionTableRow } from "../ui/table/types";
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
  const addedColumns: Column[] = [];
  const server = { refuse: true, schema: { columns: [] } as CollectionSchema };
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;
  const realApi = await import("../api");

  async function addOnServer(column: Column) {
    addedColumns.push(column);
    if (server.refuse) throw new Error("schema error: backend refused");
    server.schema = { columns: [...server.schema.columns, column] };
    return server.schema;
  }

  mock.module("../api", () => ({
    ...realApi,
    addCollectionColumn: async ({ column }: { column: Column }) =>
      addOnServer(column),
    addCollectionDateColumn: async ({ column }: { column: Column }) =>
      addOnServer(column),
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

  const { TableHeaderRow } = await import("../ui/table/table-header-row");
  const { ViewSettingsPopover } = await import("../ui/view-settings-popover");
  const { useTableViewRuntime } =
    await import("./table/use-table-view-runtime");
  const { useViewSettingsActions } =
    await import("./use-view-settings-actions");
  const { useCollectionColumnActions } =
    await import("./use-collection-column-actions");
  const { setLocale } = await import("@/paraglide/runtime.js");
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
  const viewQuery = {
    merged: {
      name: "Table",
      type: "table",
      filter: [],
      sort: [],
      groupBy: null,
    },
    invalidFilters: [],
    invalidSorts: [],
    setLocalQuery: () => undefined,
  } as unknown as UseViewQueryResult;

  function TableHeaderHarness({ schema }: { schema: CollectionSchema }) {
    // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table intentionally returns an imperative table instance for the header.
    const table = useReactTable<CollectionTableRow>({
      data: [],
      columns: [],
      getCoreRowModel: getCoreRowModel(),
    });
    return (
      <table>
        <TableHeaderRow
          table={table}
          readOnly={false}
          columns={schema.columns}
          onAddColumn={() => undefined}
        />
      </table>
    );
  }

  function ViewSettingsHarness({ schema }: { schema: CollectionSchema }) {
    const [pane, setPane] = useState<SettingsPane>("propertyAddType");
    return (
      <ViewSettingsPopover
        open
        pane={pane}
        view={{ name: "Table", type: "table" }}
        newer={false}
        renameValue="Table"
        onOpenChange={() => undefined}
        onPaneChange={setPane}
        onRenameValueChange={() => undefined}
        onRename={async () => undefined}
        onUpdateView={async () => undefined}
        onDuplicate={async () => undefined}
        onDeleteRequest={() => undefined}
        schema={schema}
        query={viewQuery}
        collectionPath="tasks"
        spacePath="/project"
        projectPath="/project"
        readOnly={false}
        onSchemaChange={() => undefined}
        autoConfigForType={() => ({})}
      />
    );
  }

  /** Opens the add menu of an entrypoint and reads it. */
  async function openAddMenu(
    entrypoint: "table" | "viewSettings",
    schema: CollectionSchema,
  ) {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    await act(async () => {
      root.render(
        entrypoint === "table" ? (
          <TableHeaderHarness schema={schema} />
        ) : (
          <ViewSettingsHarness schema={schema} />
        ),
      );
      await nextFrame(dom);
    });
    if (entrypoint === "table") {
      const plus = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === m.collection_add_property())!;
      await act(async () => {
        plus.click();
        await nextFrame(dom);
      });
    }
    const popover = dom.window.document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    )!;
    return {
      dom,
      popover,
      menu: readMenu(popover),
      cleanup: async () => {
        await act(async () => root.unmount());
        restoreGlobals();
        dom.window.close();
      },
    };
  }

  test("the table + and view settings show one add-type list with nothing marked", async () => {
    const table = await openAddMenu("table", withSingletons);
    const settings = await openAddMenu("viewSettings", withSingletons);
    try {
      expect(table.menu.rows.length).toBe(13);
      expect(table.menu).toEqual(settings.menu);
      expect(table.menu.title).toBe(m.table_property_type_title());
      expect(table.menu.notice).toBe(m.property_add_type_notice());
      expect(table.menu.rows.some((item) => item.checked)).toBe(false);
      expect(table.menu.rows[0].label).toBe(m.table_property_type_text());
      const email = row(table.menu.rows, m.table_property_type_email());
      expect(email.sensitiveHint).toBe(true);
    } finally {
      // Each render restores the globals it replaced, so close in reverse.
      await settings.cleanup();
      await table.cleanup();
    }
  });

  test("an existing Status and ID stay one line with the reason on an info icon", async () => {
    for (const entrypoint of ["table", "viewSettings"] as const) {
      const ui = await openAddMenu(entrypoint, withSingletons);
      try {
        const status = row(ui.menu.rows, m.table_property_type_status());
        expect({
          text: status.text,
          unavailable: status.unavailable,
          disabled: status.disabled,
          description: status.description,
          infoHint: status.infoHint,
        }).toEqual({
          text: m.table_property_type_status(),
          unavailable: true,
          disabled: false,
          description: statusReason,
          infoHint: true,
        });
        expect(
          row(ui.menu.rows, m.table_property_type_unique_id()).unavailable,
        ).toBe(true);
        expect(
          row(ui.menu.rows, m.table_property_type_select()).unavailable,
        ).toBe(false);
        expect(row(ui.menu.rows, m.table_property_type_select()).infoHint).toBe(
          false,
        );

        addedColumns.length = 0;
        const statusButton = rowButton(
          ui.popover,
          m.table_property_type_status(),
        );
        await act(async () => {
          statusButton.click();
          statusButton.dispatchEvent(
            new ui.dom.window.KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
            }),
          );
          await nextFrame(ui.dom);
        });
        expect(addedColumns.length).toBe(0);
        expect(
          ui.dom.window.document.querySelector(
            '[data-slot="popover-content"]',
          ) !== null,
        ).toBe(true);

        const hint = statusButton.querySelector<HTMLElement>(
          "[data-property-type-unavailable-hint]",
        )!;
        await act(async () => {
          hint.dispatchEvent(
            new ui.dom.window.MouseEvent("pointermove", { bubbles: true }),
          );
          await nextFrame(ui.dom);
        });
        expect(
          ui.dom.window.document.querySelector('[role="tooltip"]')?.textContent,
        ).toBe(statusReason);
      } finally {
        await ui.cleanup();
      }
    }

    const open = await openAddMenu("table", { columns: [] });
    try {
      expect(open.menu.rows.some((item) => item.unavailable)).toBe(false);
    } finally {
      await open.cleanup();
    }
  });

  test("new properties are named after their type in Russian from the table, view settings, board and calendar", async () => {
    setLocale("ru", { reload: false });
    server.refuse = false;
    try {
      // Table +: the column menu of the new property opens.
      server.schema = { columns: [] };
      const table = await renderTableRuntime();
      try {
        await act(async () => {
          await table.runtime().handleAddColumn("text");
        });
        expect(table.runtime().openColumn).toBe("Текст");
        await act(async () => {
          await table.runtime().handleAddColumn("text");
        });
        expect(table.runtime().openColumn).toBe("Текст 2");
      } finally {
        await table.cleanup();
      }

      // View settings: the pane of the new property opens.
      server.schema = { columns: [] };
      addedColumns.length = 0;
      const settings = await renderViewSettingsActions();
      try {
        await act(async () => {
          await settings.actions().addColumnWithType("text");
        });
        expect(settings.panes.at(-1)).toBe("propertyEdit");
        expect(settings.actions().selectedProperty).toBe("Текст");
        await act(async () => {
          await settings.actions().addColumnWithType("text");
        });
        expect(settings.actions().selectedProperty).toBe("Текст 2");
        await act(async () => {
          await settings.actions().addColumnWithType("relation");
        });
        expect(addedColumns.map((column) => column.name)).toEqual([
          "Текст",
          "Текст 2",
          "Связь",
        ]);
        // A relation points at the current collection.
        expect(addedColumns[2]).toEqual({
          name: "Связь",
          type: "relation",
          relation: "tasks",
        });
      } finally {
        await settings.cleanup();
      }

      // Board adds a Status, Calendar a date with its own label.
      server.schema = { columns: [] };
      addedColumns.length = 0;
      const columns = await renderColumnActions();
      try {
        await act(async () => {
          await columns.actions().addColumn("status");
        });
        await act(async () => {
          await columns.actions().addDateColumn({
            baseName: m.collection_date_field(),
          });
        });
        expect(addedColumns.map((column) => column.name)).toEqual([
          "Статус",
          m.collection_date_field(),
        ]);
      } finally {
        await columns.cleanup();
      }
    } finally {
      server.refuse = true;
      setLocale("en", { reload: false });
    }
  });

  test("a refused add from the table + shows a localized toast and resolves", async () => {
    toastErrors.length = 0;
    addedColumns.length = 0;
    server.schema = { columns: [{ name: "Summary", type: "text" }] };
    const consoleErrors = silenceConsoleErrors();
    const table = await renderTableRuntime();
    try {
      // A rejected promise would fail this act.
      await act(async () => {
        await table.runtime().handleAddColumn("select");
      });

      expect(addedColumns.length).toBe(1);
      expect(toastErrors).toEqual([m.property_add_failed()]);
      expect(consoleErrors.length).toBe(1);
      expect(table.schemaChanges.length).toBe(0);
      expect(table.viewPatches.length).toBe(0);
      expect(table.runtime().openColumn).toBeNull();
    } finally {
      consoleErrors.restore();
      await table.cleanup();
    }
  });

  test("a refused add from view settings shows a localized toast and stays on the type pane", async () => {
    toastErrors.length = 0;
    addedColumns.length = 0;
    server.schema = { columns: [{ name: "Summary", type: "text" }] };
    const consoleErrors = silenceConsoleErrors();
    const settings = await renderViewSettingsActions();
    try {
      // A rejected promise would fail this act.
      await act(async () => {
        await settings.actions().addColumnWithType("multi_select");
      });

      expect(addedColumns.length).toBe(1);
      expect(toastErrors).toEqual([m.property_add_failed()]);
      expect(consoleErrors.length).toBe(1);
      expect(settings.schemaChanges.length).toBe(0);
      expect(settings.viewPatches.length).toBe(0);
      expect(settings.panes.includes("propertyEdit")).toBe(false);
    } finally {
      consoleErrors.restore();
      await settings.cleanup();
    }
  });

  /** Renders a hook against the server schema, kept in sync with it. */
  async function renderHook<T>(
    use: (props: {
      schema: CollectionSchema;
      onSchemaChange: (schema: CollectionSchema) => void;
    }) => T,
  ) {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const schemaChanges: CollectionSchema[] = [];
    let current: T | null = null;

    function Harness() {
      const [schema, setSchema] = useState(server.schema);
      const value = use({
        schema,
        onSchemaChange: (next) => {
          schemaChanges.push(next);
          setSchema(next);
        },
      });
      useEffect(() => {
        current = value;
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    return {
      current: () => current!,
      schemaChanges,
      cleanup: async () => {
        await act(async () => root.unmount());
        restoreGlobals();
        dom.window.close();
      },
    };
  }

  async function renderTableRuntime() {
    const viewPatches: unknown[] = [];
    const hook = await renderHook(({ schema, onSchemaChange }) => {
      const props: Partial<TableViewProps> = {
        name: "Table",
        view: { name: "Table", type: "table" } as CollectionView,
        schema,
        collectionPath: "tasks",
        spacePath: "/project",
        projectPath: "/project",
        searchQuery: "",
        filters: [],
        sort: [],
        refreshToken: 0,
        onSchemaChange,
        onUpdateView: async (_name, patch) => {
          viewPatches.push(patch);
        },
        onCreatePage: async () => {
          throw new Error("unused");
        },
      };
      return useTableViewRuntime(props as TableViewProps);
    });
    return { ...hook, runtime: hook.current, viewPatches };
  }

  async function renderViewSettingsActions() {
    const panes: SettingsPane[] = [];
    const viewPatches: unknown[] = [];
    const hook = await renderHook(({ schema, onSchemaChange }) =>
      useViewSettingsActions({
        view: { name: "Table", type: "table" },
        schema,
        query: viewQuery,
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
        onSchemaChange,
      }),
    );
    return { ...hook, actions: hook.current, panes, viewPatches };
  }

  async function renderColumnActions() {
    const hook = await renderHook(({ schema, onSchemaChange }) =>
      useCollectionColumnActions({
        schema,
        spacePath: "/project",
        collectionPath: "tasks",
        projectPath: "/project",
        onSchemaChange,
      }),
    );
    return { ...hook, actions: hook.current };
  }
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
      text: visibleText(button),
      className: button.className,
      disabled: button.disabled,
      unavailable: button.getAttribute("aria-disabled") === "true",
      description: describedBy
        ? (document.getElementById(describedBy)?.textContent ?? null)
        : null,
      infoHint:
        button.querySelector(
          "[data-property-type-unavailable-hint] .lucide-info",
        ) !== null,
      sensitiveHint: button.querySelector(".lucide-triangle-alert") !== null,
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

function visibleText(element: Element): string {
  return Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === 3) return node.textContent ?? "";
      const child = node as Element;
      return child.hasAttribute("hidden") ? "" : visibleText(child);
    })
    .join("");
}

function rowButton(popover: HTMLElement, label: string) {
  return Array.from(
    popover.querySelectorAll<HTMLButtonElement>(".p-1 > button"),
  ).find(
    (button) => button.querySelector(".font-medium")?.textContent === label,
  )!;
}

function row<T extends { label: string }>(rows: T[], label: string) {
  return rows.find((item) => item.label === label)!;
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
