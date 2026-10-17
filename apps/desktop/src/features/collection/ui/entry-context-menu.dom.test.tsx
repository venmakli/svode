import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { CollectionEntryMenu } from "../model";

if (process.env.SVODE_COLLECTION_ENTRY_MENU_DOM !== "1") {
  test("Collection row context menus DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ENTRY_MENU_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    SVGElement: dom.window.SVGElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    DOMRect:
      dom.window.DOMRect ??
      class {
        static fromRect(rect: Partial<DOMRect> = {}) {
          return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            ...rect,
          };
        }
      },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  let detail = { form: "folder", subpageCount: 0, otherFileCount: 0 };
  let entries: Page[] = [];
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => 0,
      invoke: async (command: string) => {
        if (command === "get_page_detail_state") return detail;
        if (command === "navigation_read") return { pinned: [], kept: [] };
        if (command === "list_collection_view_items") return entries;
        return null;
      },
    },
  });

  const { createRoot } = await import("react-dom/client");
  const { DndContext } = await import("@dnd-kit/core");
  const { SortableContext } = await import("@dnd-kit/sortable");
  const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
    await import("@/components/ui/dropdown-menu");
  const { Table, TableBody, TableCell } = await import("@/components/ui/table");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ContentActionMenuItems, contentActionGroups } =
    await import("@/features/content-actions");
  const { getNavigationState } = await import("@/features/navigation");
  const { pageNavigationItem } = await import("@/features/page");
  const { CollectionEntryMenuProvider } = await import("./entry-context-menu");
  const { SortableTableRow } = await import("./table/table-row");
  const { BoardCardContent } = await import("./board/board-card");
  const { CollectionListRowContent } = await import("./list/list-row");
  const { SortableGalleryCard } = await import("./gallery/gallery-card");
  const { CalendarEventContent } =
    await import("./calendar/calendar-event-content");
  const { ViewPlaceholder } = await import("./view-placeholder");

  function page(path: string, title = "Roadmap"): Page {
    return {
      path,
      body: "",
      meta: { title, icon: null, created: "", updated: "", extra: {} },
    };
  }

  const leaf = page("plans/roadmap.md");
  const folder = page("plans/launch/README.md", "Launch");
  const calls: string[] = [];
  const menuValue = (readOnly: boolean): CollectionEntryMenu => ({
    readOnly,
    spacePath: "/space",
    pinItem: (entry) => pageNavigationItem(entry, "space", null),
    handlers: (entry) => ({
      "nest-page": () => calls.push(`nest-page:${entry.path}`),
      "new-item": () => calls.push(`new-item:${entry.path}`),
      "new-folder": () => calls.push(`new-folder:${entry.path}`),
      "make-collection": () => calls.push(`make-collection:${entry.path}`),
      "make-leaf": () => calls.push(`make-leaf:${entry.path}`),
      rename: () => calls.push(`rename:${entry.path}`),
      duplicate: () => calls.push(`duplicate:${entry.path}`),
      delete: () => calls.push(`delete:${entry.path}`),
    }),
  });
  const open = (entry: Page) => () => calls.push(`open:${entry.path}`);
  const noop = () => undefined;

  /** Each view's row of `entry`; its element answers the context menu. */
  const views: Record<
    string,
    {
      render: (entry: Page, nested?: boolean) => ReactNode;
      row: (entry: Page) => string;
    }
  > = {
    table: {
      render: (entry, nested = false) => (
        <DndContext>
          <Table>
            <TableBody>
              <SortableTableRow
                disabled
                registerRow={noop}
                row={{
                  child: false,
                  entry,
                  level: 0,
                  nestedCollection: nested,
                }}
                rowHeightClassName="h-9"
                selected={false}
                tabIndex={0}
                onFocus={noop}
                onMoveFocus={noop}
                onOpen={open(entry)}
              >
                <TableCell>{entry.meta.title}</TableCell>
              </SortableTableRow>
            </TableBody>
          </Table>
        </DndContext>
      ),
      row: (entry) => `[data-table-row-path="${entry.path}"]`,
    },
    board: {
      render: (entry, nested = false) => (
        <BoardCardContent
          readOnly={false}
          card={{ entry, groupKey: "todo" }}
          groupColumn={{ name: "status", type: "status" }}
          cardFields={[]}
          customColumns={[]}
          nestedCollectionPaths={
            new Set(nested ? [entry.path.replace(/\/README\.md$/, "")] : [])
          }
          disabledReorder
          active={false}
          spacePath="/space"
          actors={[]}
          onRequestActors={async () => []}
          onOpen={(item) => open(item)()}
          onOpenNestedPeek={noop}
          onOpenNestedCollection={noop}
          onOpenFullPage={noop}
          onOpenPath={noop}
        />
      ),
      row: () => ".group\\/board-card",
    },
    list: {
      render: (entry, nested = false) => (
        <CollectionListRowContent
          actors={[]}
          cardFields={[]}
          density="compact"
          disabledReorder
          dragAttributes={{}}
          focused={false}
          properties={[]}
          row={{
            entry,
            expandable: false,
            expanded: false,
            level: 0,
            nestedCollection: nested,
          }}
          spacePath="/space"
          onFocusRow={noop}
          onKeyboardMove={noop}
          onOpen={(item) => open(item)()}
          onOpenNestedCollection={noop}
          onOpenPath={noop}
          onRequestActors={async () => []}
          onToggle={noop}
        />
      ),
      row: (entry) => `[data-list-row-path="${entry.path}"]`,
    },
    gallery: {
      render: (entry, nested = false) => (
        <DndContext>
          <SortableContext items={[entry.path]}>
            <SortableGalleryCard
              entry={entry}
              cover={null}
              cardFields={["title"]}
              properties={[]}
              coverFit="cover"
              coverAspect="16 / 9"
              spacePath="/space"
              actors={[]}
              nestedCollection={nested}
              folder={false}
              disabledReorder
              focused={false}
              onRequestActors={async () => []}
              onOpen={(item) => open(item)()}
              onOpenNestedCollection={noop}
              onOpenPath={noop}
              onFocusCard={noop}
              onKeyboardMove={noop}
            />
          </SortableContext>
        </DndContext>
      ),
      row: (entry) => `[data-gallery-card-path="${entry.path}"]`,
    },
    calendar: {
      render: (entry, nested = false) => (
        <CalendarEventContent
          readOnly={false}
          arg={
            {
              timeText: "",
              event: {
                extendedProps: {
                  model: {
                    entry,
                    value: { start: "2026-10-17" },
                    dateField: "due",
                    cardFields: [],
                    customColumns: [],
                    folder: false,
                    nestedCollection: nested,
                    color: null,
                  },
                },
              },
            } as never
          }
          scope="month"
          onOpen={(item) => open(item)()}
          onOpenNestedPeek={noop}
          onOpenNestedCollection={noop}
          propertyContext={{
            spacePath: "/space",
            onOpenPath: noop,
            actors: [],
            onRequestActors: async () => [],
            onUpdateField: noop,
          }}
        />
      ),
      row: () => ".svode-calendar-event-content",
    },
  };

  let root: ReturnType<typeof createRoot> | null = null;
  async function render(node: ReactNode, readOnly = false) {
    await act(async () => root?.unmount());
    root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root!.render(
        <TooltipProvider>
          <CollectionEntryMenuProvider value={menuValue(readOnly)}>
            {node}
          </CollectionEntryMenuProvider>
        </TooltipProvider>,
      ),
    );
  }

  async function openContextMenu(selector: string) {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`no row ${selector}`);
    await act(async () => {
      target.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function menuItems(role = "[data-slot=context-menu-content]") {
    const content = document.querySelector(role);
    return [
      ...(content?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
    ];
  }
  const labels = (items: HTMLElement[]) =>
    items.map((item) => item.textContent ?? "");
  const groupIds = (role = "[data-slot=context-menu-content]") =>
    [
      ...(document
        .querySelector(role)
        ?.querySelectorAll("[data-content-action-group]") ?? []),
    ].map((group) => group.getAttribute("data-content-action-group"));

  async function closeMenu() {
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
  }

  /** The menu the Peek of the same item shows, from the same catalog. */
  async function peekMenuLabels(entry: Page, readOnly = false) {
    const form = entry.path.endsWith("README.md") ? "folder" : "leaf";
    await act(async () => root?.unmount());
    root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root!.render(
        <DropdownMenu open>
          <DropdownMenuTrigger>open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <ContentActionMenuItems
              groups={contentActionGroups({
                object: {
                  kind: "collection-item",
                  form,
                  contents:
                    form === "folder"
                      ? {
                          subpageCount: detail.subpageCount,
                          otherFileCount: detail.otherFileCount,
                        }
                      : null,
                },
                readOnly,
              })}
              pinItem={pageNavigationItem(entry, "space", null)}
              handlers={{}}
            />
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    return menuItems("[data-slot=dropdown-menu-content]").map((item) => ({
      label: item.textContent,
      disabled: item.hasAttribute("data-disabled"),
    }));
  }

  test("every view's row menu is Open in peek and then the Peek menu of the item", async () => {
    await act(async () => getNavigationState().setProject("/project"));
    const peek = await peekMenuLabels(leaf);
    expect(peek.map((item) => item.label)).toEqual([
      "Pin",
      "Keep in Now",
      "Nest page",
      "New folder",
      "Make collection",
      "Rename",
      "Duplicate",
      "Delete",
    ]);
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(leaf));
      await openContextMenu(view.row(leaf));
      const items = menuItems();
      expect([name, ...labels(items)]).toEqual([
        name,
        "Open in peek",
        ...peek.map((item) => item.label!),
      ]);
      expect([name, ...groupIds()]).toEqual([
        name,
        "open",
        "navigation",
        "create",
        "convert",
        "edit",
        "delete",
      ]);
      const deleteItem = items.at(-1)!;
      expect(deleteItem.getAttribute("data-variant")).toBe("destructive");
      await closeMenu();
    }
  });

  test("a row of a page with subpages offers Make regular page with its reason, like its Peek", async () => {
    detail = { form: "folder", subpageCount: 2, otherFileCount: 0 };
    const peek = await peekMenuLabels(folder);
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(folder));
      await openContextMenu(view.row(folder));
      const items = menuItems();
      expect([name, ...labels(items)]).toEqual([
        name,
        "Open in peek",
        ...peek.map((item) => item.label!),
      ]);
      const makeLeaf = items.find(
        (item) => item.getAttribute("data-content-action") === "make-leaf",
      )!;
      expect(makeLeaf.hasAttribute("data-disabled")).toBe(true);
      expect(makeLeaf.textContent?.includes("2")).toBe(true);
      await closeMenu();
    }
    detail = { form: "folder", subpageCount: 0, otherFileCount: 0 };
  });

  test("a row of a nested Collection shows the Collection menu, like its Peek", async () => {
    const nested = page("plans/backlog/README.md", "Backlog");
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(nested, true));
      await openContextMenu(view.row(nested));
      expect([name, ...labels(menuItems())]).toEqual([
        name,
        "Open in peek",
        "Pin",
        "Keep in Now",
        "New item",
        "Rename",
        "Delete",
      ]);
      calls.length = 0;
      const newItem = menuItems().find(
        (item) => item.getAttribute("data-content-action") === "new-item",
      )!;
      await act(async () => newItem.click());
      expect([name, ...calls]).toEqual([name, `new-item:${nested.path}`]);
    }
  });

  test("read-only rows keep every item visible and leave only opening and pinning available", async () => {
    const peek = await peekMenuLabels(leaf, true);
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(leaf), true);
      await openContextMenu(view.row(leaf));
      const items = menuItems();
      expect([name, ...labels(items)]).toEqual([
        name,
        "Open in peek",
        ...peek.map((item) => item.label!),
      ]);
      const enabled = items
        .filter((item) => !item.hasAttribute("data-disabled"))
        .map((item) => item.textContent);
      expect([name, ...enabled]).toEqual([
        name,
        "Open in peek",
        "Pin",
        "Keep in Now",
      ]);
      await closeMenu();
    }
  });

  test("row items open, duplicate, delete and run the item's operations", async () => {
    for (const [name, view] of Object.entries(views)) {
      for (const action of [
        "open-in-peek",
        "nest-page",
        "new-folder",
        "make-collection",
        "rename",
        "duplicate",
        "delete",
      ]) {
        calls.length = 0;
        await render(view.render(leaf));
        await openContextMenu(view.row(leaf));
        const item = menuItems().find(
          (candidate) =>
            candidate.getAttribute("data-content-action") === action,
        )!;
        await act(async () => item.click());
        const expected =
          action === "open-in-peek"
            ? `open:${leaf.path}`
            : `${action}:${leaf.path}`;
        expect([name, ...calls]).toEqual([name, expected]);
      }
    }
  });

  test("the placeholder list rows use the same item menu", async () => {
    const peek = await peekMenuLabels(leaf);
    entries = [leaf];
    await render(
      <ViewPlaceholder
        readOnly={false}
        type="list"
        name="All"
        schema={{ columns: [], views: [] }}
        collectionPath="plans"
        spacePath="/space"
        searchQuery=""
        refreshToken={0}
        onActivateItem={(entry) => open(entry)()}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = [...document.querySelectorAll<HTMLElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Roadmap"),
    )!;
    button.setAttribute("data-placeholder-row", "");
    await openContextMenu("[data-placeholder-row]");
    expect(labels(menuItems())).toEqual([
      "Open in peek",
      ...peek.map((item) => item.label!),
    ]);
    calls.length = 0;
    await act(async () => menuItems()[0]!.click());
    expect(calls).toEqual([`open:${leaf.path}`]);
  });
}
