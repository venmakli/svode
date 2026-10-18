import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { CollectionSchema } from "@/features/properties";
import type { CollectionView, UseViewQueryResult } from "../query";
import type { SettingsPane } from "../model";

const isolatedProcess =
  process.env.SVODE_VIEW_SETTINGS_PROPERTY_TYPE_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("view settings property type DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_VIEW_SETTINGS_PROPERTY_TYPE_DOM_PROCESS: "1",
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
  const typeChanges: unknown[] = [];
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;
  const realPropertiesPlatform =
    await import("@/platform/properties/properties-api");

  mock.module("@/platform/properties/properties-api", () => ({
    ...realPropertiesPlatform,
    changeSchemaType: async (input: {
      columnName: string;
      newType: string;
    }) => {
      typeChanges.push(input);
      return {
        schema: {
          columns: schema.columns.map((column) =>
            column.name === input.columnName
              ? { ...column, type: input.newType }
              : column,
          ),
        },
        warnings: [],
      };
    },
  }));
  mock.module("sonner", () => ({
    toast: {
      error: () => undefined,
      success: () => undefined,
      warning: () => undefined,
    },
  }));

  const { ViewSettingsPopover } = await import("./view-settings-popover");
  const m = await import("@/paraglide/messages.js");

  const schema: CollectionSchema = {
    columns: [
      { name: "Note", type: "text" },
      { name: "Tags", type: "multi_select", options: [] },
      { name: "Done", type: "boolean" },
    ],
  };
  const view: CollectionView = {
    name: "Table",
    type: "table",
    visible_fields: ["title", "Note", "Tags", "Done"],
  };
  const query = {
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

  async function renderSettings() {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const schemaChanges: CollectionSchema[] = [];
    function Harness() {
      const [open, setOpen] = useState(true);
      const [pane, setPane] = useState<SettingsPane>("properties");
      const [current, setCurrent] = useState(schema);
      return (
        <>
          <button
            type="button"
            data-reopen-settings
            onClick={() => {
              setPane("properties");
              setOpen(true);
            }}
          />
          <ViewSettingsPopover
            open={open}
            pane={pane}
            view={view}
            renameValue="Table"
            onOpenChange={setOpen}
            onPaneChange={setPane}
            onRenameValueChange={() => undefined}
            onRename={async () => undefined}
            onUpdateView={async () => undefined}
            onDuplicate={async () => undefined}
            onDeleteRequest={() => undefined}
            schema={current}
            query={query}
            collectionPath="tasks"
            spacePath="/project"
            projectPath="/project"
            readOnly={false}
            onSchemaChange={(next) => {
              schemaChanges.push(next);
              setCurrent(next);
            }}
            autoConfigForType={() => ({})}
          />
        </>
      );
    }

    await act(async () => {
      root.render(<Harness />);
      await nextFrame(dom);
    });
    const document = dom.window.document;
    const popover = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    const dialog = () =>
      document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    const click = async (element: HTMLElement) => {
      await act(async () => {
        element.click();
        await nextFrame(dom);
      });
    };
    const button = (container: HTMLElement, text: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.textContent?.startsWith(text),
      )!;
    return {
      dom,
      popover,
      dialog,
      click,
      button,
      schemaChanges,
      reopen: () =>
        click(document.querySelector<HTMLElement>("[data-reopen-settings]")!),
      cleanup: async () => {
        await act(async () => {
          root.unmount();
          await nextFrame(dom);
        });
        restoreGlobals();
        dom.window.close();
      },
    };
  }

  test("Type of a custom property opens the type list and the change type dialog", async () => {
    typeChanges.length = 0;
    const ui = await renderSettings();
    try {
      await ui.click(ui.button(ui.popover()!, "Tags"));
      const typeRow = ui.button(ui.popover()!, m.table_column_type());
      expect(typeRow.textContent).toBe(
        `${m.table_column_type()}${m.table_property_type_multi_select()}`,
      );
      expect(typeRow.querySelector(".lucide-chevron-right") !== null).toBe(
        true,
      );

      await ui.reopen();
      await ui.click(ui.button(ui.popover()!, "Note"));
      await ui.click(ui.button(ui.popover()!, m.table_column_type()));
      const typePane = ui.popover()!;
      expect(typePane.textContent.includes(m.table_column_type())).toBe(true);
      expect(
        typePane.textContent.includes(m.property_dialog_change_type_desc()),
      ).toBe(true);
      const typeRows = Array.from(
        typePane.querySelectorAll<HTMLButtonElement>(".p-1 > button"),
      );
      expect(typeRows.length).toBe(13);
      const active = ui.button(typePane, m.table_property_type_text());
      expect(active.disabled).toBe(true);
      expect(active.querySelector(".lucide-check") !== null).toBe(true);
      expect(ui.button(typePane, m.table_property_type_select()).disabled).toBe(
        false,
      );

      // Back returns to the property, not to the view settings root.
      await ui.click(
        Array.from(typePane.querySelectorAll<HTMLButtonElement>("button")).find(
          (item) => item.textContent === "Back",
        )!,
      );
      expect(
        ui.popover()!.querySelector(".truncate.text-sm.font-medium")
          ?.textContent,
      ).toBe("Note");
      expect(ui.button(ui.popover()!, m.table_visible()) !== undefined).toBe(
        true,
      );

      await ui.click(ui.button(ui.popover()!, m.table_column_type()));
      await ui.click(ui.button(ui.popover()!, m.table_property_type_select()));
      expect(ui.popover()).toBeNull();
      const dialog = ui.dialog()!;
      expect(
        dialog.textContent.includes(m.property_dialog_change_type_title()),
      ).toBe(true);
      expect(
        dialog.querySelector('[data-slot="select-value"]')?.textContent,
      ).toBe(m.table_property_type_select());
      expect(typeChanges.length).toBe(0);

      await ui.click(ui.button(dialog, m.project_cancel()));
      expect(ui.dialog()).toBeNull();
      expect(typeChanges.length).toBe(0);
      expect(ui.schemaChanges.length).toBe(0);

      await ui.reopen();
      await ui.click(ui.button(ui.popover()!, "Note"));
      await ui.click(ui.button(ui.popover()!, m.table_column_type()));
      await ui.click(ui.button(ui.popover()!, m.table_property_type_select()));
      await ui.click(ui.button(ui.dialog()!, m.settings_save()));
      expect(typeChanges).toEqual([
        {
          spacePath: "/project",
          collectionPath: "tasks",
          projectPath: "/project",
          columnName: "Note",
          newType: "select",
          conversionStrategy: undefined,
        },
      ]);
      expect(ui.dialog()).toBeNull();
      expect(ui.schemaChanges.length).toBe(1);
      expect(ui.schemaChanges[0]!.columns[0]!.type).toBe("select");
    } finally {
      await ui.cleanup();
    }
  });

  test("system fields show a fixed type that is not interactive", async () => {
    const ui = await renderSettings();
    try {
      const fixedTypes: Array<[string, string]> = [
        [m.collection_field_title(), m.table_property_type_text()],
        [m.collection_field_icon(), m.collection_field_type_icon()],
        [m.collection_field_description(), m.table_property_type_text()],
        [m.collection_field_created(), m.table_property_type_date()],
        [m.collection_field_updated(), m.table_property_type_date()],
      ];
      for (const [field, type] of fixedTypes) {
        await ui.reopen();
        await ui.click(ui.button(ui.popover()!, field));
        const pane = ui.popover()!;
        expect(ui.button(pane, m.table_column_type()) === undefined).toBe(true);
        const typeRow = Array.from(pane.querySelectorAll("div")).find(
          (item) =>
            item.textContent === `${m.table_column_type()}${type}` &&
            item.children.length === 3,
        )!;
        expect(typeRow !== undefined).toBe(true);
        expect(typeRow.closest("button")).toBeNull();
        expect(typeRow.hasAttribute("tabindex")).toBe(false);
        expect(typeRow.querySelector(".lucide-chevron-right")).toBeNull();
        for (const label of [
          m.table_visible(),
          m.table_filter(),
          m.view_query_sort_title(),
        ]) {
          expect(ui.button(pane, label) !== undefined).toBe(true);
        }
      }

      await ui.reopen();
      await ui.click(ui.button(ui.popover()!, "Done"));
      const booleanPane = ui.popover()!;
      expect(booleanPane.textContent.includes(m.table_type_settings())).toBe(
        true,
      );
      expect(ui.button(booleanPane, m.table_column_type()).textContent).toBe(
        `${m.table_column_type()}${m.table_property_type_boolean()}`,
      );
    } finally {
      await ui.cleanup();
    }
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
