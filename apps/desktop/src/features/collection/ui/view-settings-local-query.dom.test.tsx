import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { CollectionSchema } from "@/features/properties";
import type { CollectionView, QueryFilter } from "../query";
import type { SettingsPane } from "../model";

const isolatedProcess =
  process.env.SVODE_VIEW_SETTINGS_LOCAL_QUERY_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("view settings local query DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_VIEW_SETTINGS_LOCAL_QUERY_DOM_PROCESS: "1",
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
  const viewUpdates: Array<{
    viewName: string;
    patch: Record<string, unknown>;
  }> = [];
  const mock = bunTest.mock;
  const realApi = await import("../api");

  mock.module("../api", () => ({
    ...realApi,
    listenCollectionQueryInvalidations: async () => () => undefined,
    updateCollectionView: async ({
      viewName,
      patch,
    }: {
      viewName: string;
      patch: Record<string, unknown>;
    }) => {
      viewUpdates.push({ viewName, patch });
      return {
        ...savedSchema,
        views: [{ ...savedView, ...patch }],
      } satisfies CollectionSchema;
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
  const { useViewQuery } = await import("../query/hooks");
  const m = await import("@/paraglide/messages.js");

  const savedFilter: QueryFilter = { field: "Status", op: "eq", value: "Todo" };
  const savedView: CollectionView = {
    name: "Cards",
    type: "table",
    filter: [savedFilter],
    sort: [{ field: "Status", desc: false }],
  };
  const savedSchema: CollectionSchema = {
    columns: [
      {
        name: "Status",
        type: "select",
        options: [{ name: "Todo" }, { name: "Done" }],
      },
    ],
    views: [savedView],
  };

  async function renderSettings({
    initialPane,
    readOnly = false,
  }: {
    initialPane: SettingsPane;
    readOnly?: boolean;
  }) {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    function Harness() {
      const [open, setOpen] = useState(true);
      const [pane, setPane] = useState<SettingsPane>(initialPane);
      const [schema, setSchema] = useState(savedSchema);
      const view = (schema.views?.[0] ?? null) as CollectionView | null;
      const query = useViewQuery({
        spacePath: "/project",
        projectPath: "/project",
        collectionPath: "Cards",
        viewName: "Cards",
        schema,
        view,
      });
      return (
        <ViewSettingsPopover
          open={open}
          pane={pane}
          view={view}
          newer={false}
          renameValue="Cards"
          onOpenChange={setOpen}
          onPaneChange={setPane}
          onRenameValueChange={() => undefined}
          onRename={async () => undefined}
          onUpdateView={async () => undefined}
          onDuplicate={async () => undefined}
          onDeleteRequest={() => undefined}
          schema={schema}
          query={query}
          collectionPath="Cards"
          spacePath="/project"
          projectPath="/project"
          readOnly={readOnly}
          onSchemaChange={setSchema}
          autoConfigForType={() => ({})}
        />
      );
    }

    await act(async () => {
      root.render(<Harness />);
      await nextFrame(dom);
    });
    const document = dom.window.document;
    const popover = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    const trigger = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!;
    const button = (text: string) =>
      Array.from(popover().querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.textContent?.includes(text),
      );
    const click = async (element: HTMLElement) => {
      await act(async () => {
        element.click();
        await nextFrame(dom);
      });
    };
    return {
      popover,
      button,
      click,
      hasNotice: () =>
        popover().textContent?.includes(m.view_query_local_notice()) ?? false,
      hasIndicator: () =>
        trigger().querySelector("[data-local-query-changes]") !== null &&
        (trigger().textContent?.includes(
          m.view_query_local_changes_indicator(),
        ) ??
          false),
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

  test("deleting a saved sort keeps the list able to save the query for everyone", async () => {
    viewUpdates.length = 0;
    const ui = await renderSettings({ initialPane: "sort" });
    try {
      expect(ui.button(m.view_query_save_for_all())).toBe(undefined);
      expect(ui.hasNotice()).toBe(false);
      expect(ui.hasIndicator()).toBe(false);

      await ui.click(ui.button("Status")!);
      await ui.click(ui.button(m.view_query_delete_sort())!);

      expect(
        ui.popover().textContent?.includes(m.view_query_sort_empty()),
      ).toBe(true);
      expect(ui.hasNotice()).toBe(true);
      expect(ui.hasIndicator()).toBe(true);
      await ui.click(ui.button(m.view_query_save_for_all())!);

      expect(viewUpdates).toEqual([
        {
          viewName: "Cards",
          patch: { filter: [savedFilter], sort: [], group_by: null },
        },
      ]);
      expect(ui.button(m.view_query_save_for_all())).toBe(undefined);
      expect(ui.hasNotice()).toBe(false);
      expect(ui.hasIndicator()).toBe(false);
    } finally {
      await ui.cleanup();
    }
  });

  test("clearing a saved filter keeps the list able to save the query for everyone", async () => {
    viewUpdates.length = 0;
    const ui = await renderSettings({ initialPane: "filter" });
    try {
      expect(ui.button(m.view_query_save_for_all())).toBe(undefined);
      expect(ui.hasNotice()).toBe(false);
      expect(ui.hasIndicator()).toBe(false);

      await ui.click(ui.button("Status")!);
      await ui.click(ui.button(m.view_query_clear_filter())!);

      expect(
        ui.popover().textContent?.includes(m.view_query_filter_empty()),
      ).toBe(true);
      expect(ui.hasNotice()).toBe(true);
      expect(ui.hasIndicator()).toBe(true);
      await ui.click(ui.button(m.view_query_save_for_all())!);

      expect(viewUpdates).toEqual([
        {
          viewName: "Cards",
          patch: {
            filter: [],
            sort: [{ field: "Status", desc: false }],
            group_by: null,
          },
        },
      ]);
      expect(ui.button(m.view_query_save_for_all())).toBe(undefined);
      expect(ui.hasNotice()).toBe(false);
      expect(ui.hasIndicator()).toBe(false);
    } finally {
      await ui.cleanup();
    }
  });

  test("read-only lists show local changes without saving them for everyone", async () => {
    viewUpdates.length = 0;
    const ui = await renderSettings({ initialPane: "sort", readOnly: true });
    try {
      await ui.click(ui.button("Status")!);
      await ui.click(ui.button(m.view_query_delete_sort())!);

      expect(
        ui.popover().textContent?.includes(m.view_query_sort_empty()),
      ).toBe(true);
      expect(ui.hasNotice()).toBe(true);
      expect(ui.hasIndicator()).toBe(true);
      expect(ui.button(m.view_query_save_for_all())).toBe(undefined);
      expect(viewUpdates).toEqual([]);
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
