import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { CollectionItemMenu } from "../model";

if (process.env.SVODE_COLLECTION_ITEM_MENU_DOM !== "1") {
  test("Collection item context menus DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ITEM_MENU_DOM: "1" },
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
  let items: Page[] = [];
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => 0,
      invoke: async (command: string) => {
        if (command === "get_page_detail_state") return detail;
        if (command === "navigation_read") return { pinned: [], kept: [] };
        if (command === "list_collection_view_items") return items;
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
  const { CollectionItemMenuProvider } = await import("./item-context-menu");
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
  const menuValue = (readOnly: boolean): CollectionItemMenu => ({
    readOnly,
    spacePath: "/space",
    pinItem: (item) => pageNavigationItem(item, "space", null),
    handlers: (item) => ({
      "nest-page": () => calls.push(`nest-page:${item.path}`),
      "new-item": () => calls.push(`new-item:${item.path}`),
      "new-folder": () => calls.push(`new-folder:${item.path}`),
      "make-collection": () => calls.push(`make-collection:${item.path}`),
      "make-leaf": () => calls.push(`make-leaf:${item.path}`),
      rename: () => calls.push(`rename:${item.path}`),
      duplicate: () => calls.push(`duplicate:${item.path}`),
      delete: () => calls.push(`delete:${item.path}`),
    }),
  });
  const open = (item: Page) => () => calls.push(`open:${item.path}`);
  const noop = () => undefined;

  /** Each view's element of `item`; it answers the context menu. */
  const views: Record<
    string,
    {
      render: (item: Page, nested?: boolean) => ReactNode;
      target: (item: Page) => string;
    }
  > = {
    table: {
      render: (item, nested = false) => (
        <DndContext>
          <Table>
            <TableBody>
              <SortableTableRow
                disabled
                registerRow={noop}
                row={{
                  child: false,
                  item,
                  level: 0,
                  nestedCollection: nested,
                }}
                rowHeightClassName="h-9"
                selected={false}
                tabIndex={0}
                onFocus={noop}
                onMoveFocus={noop}
                onOpen={open(item)}
              >
                <TableCell>{item.meta.title}</TableCell>
              </SortableTableRow>
            </TableBody>
          </Table>
        </DndContext>
      ),
      target: (item) => `[data-table-row-path="${item.path}"]`,
    },
    board: {
      render: (item, nested = false) => (
        <BoardCardContent
          readOnly={false}
          card={{ item, groupKey: "todo" }}
          groupColumn={{ name: "status", type: "status" }}
          cardFields={[]}
          customColumns={[]}
          nestedCollectionPaths={
            new Set(nested ? [item.path.replace(/\/README\.md$/, "")] : [])
          }
          active={false}
          spacePath="/space"
          actors={[]}
          onRequestActors={async () => []}
          onOpen={(opened) => open(opened)()}
          onOpenNestedPeek={noop}
          onOpenNestedCollection={noop}
          onOpenFullPage={noop}
          onOpenPath={noop}
        />
      ),
      target: () => ".group\\/board-card",
    },
    list: {
      render: (item, nested = false) => (
        <CollectionListRowContent
          actors={[]}
          cardFields={[]}
          density="compact"
          disabledReorder
          dragAttributes={{}}
          focused={false}
          properties={[]}
          row={{
            item,
            expandable: false,
            expanded: false,
            level: 0,
            nestedCollection: nested,
          }}
          spacePath="/space"
          onFocusRow={noop}
          onKeyboardMove={noop}
          onOpen={(opened) => open(opened)()}
          onOpenNestedCollection={noop}
          onOpenPath={noop}
          onRequestActors={async () => []}
          onToggle={noop}
        />
      ),
      target: (item) => `[data-list-row-path="${item.path}"]`,
    },
    gallery: {
      render: (item, nested = false) => (
        <DndContext>
          <SortableContext items={[item.path]}>
            <SortableGalleryCard
              item={item}
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
              onOpen={(opened) => open(opened)()}
              onOpenNestedCollection={noop}
              onOpenPath={noop}
              onFocusCard={noop}
              onKeyboardMove={noop}
            />
          </SortableContext>
        </DndContext>
      ),
      target: (item) => `[data-gallery-card-path="${item.path}"]`,
    },
    calendar: {
      render: (item, nested = false) => (
        <CalendarEventContent
          readOnly={false}
          arg={
            {
              timeText: "",
              event: {
                extendedProps: {
                  model: {
                    item,
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
          onOpen={(opened) => open(opened)()}
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
      target: () => ".svode-calendar-event-content",
    },
  };

  let root: ReturnType<typeof createRoot> | null = null;
  async function render(node: ReactNode, readOnly = false) {
    await act(async () => root?.unmount());
    root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root!.render(
        <TooltipProvider>
          <CollectionItemMenuProvider value={menuValue(readOnly)}>
            {node}
          </CollectionItemMenuProvider>
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
  const labels = (menu: HTMLElement[]) =>
    menu.map((element) => element.textContent ?? "");
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
  async function peekMenuLabels(item: Page, readOnly = false) {
    const form = item.path.endsWith("README.md") ? "folder" : "leaf";
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
              pinItem={pageNavigationItem(item, "space", null)}
              handlers={{}}
            />
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    return menuItems("[data-slot=dropdown-menu-content]").map((element) => ({
      label: element.textContent,
      disabled: element.hasAttribute("data-disabled"),
    }));
  }

  test("every view's item menu is Open in peek and then the Peek menu of the item", async () => {
    await act(async () => getNavigationState().setProject("/project"));
    const peek = await peekMenuLabels(leaf);
    expect(peek.map((option) => option.label)).toEqual([
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
      await openContextMenu(view.target(leaf));
      const menu = menuItems();
      expect([name, ...labels(menu)]).toEqual([
        name,
        "Open in peek",
        ...peek.map((option) => option.label!),
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
      const deleteItem = menu.at(-1)!;
      expect(deleteItem.getAttribute("data-variant")).toBe("destructive");
      await closeMenu();
    }
  });

  test("an item with subpages offers Make regular page with its reason, like its Peek", async () => {
    detail = { form: "folder", subpageCount: 2, otherFileCount: 0 };
    const peek = await peekMenuLabels(folder);
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(folder));
      await openContextMenu(view.target(folder));
      const menu = menuItems();
      expect([name, ...labels(menu)]).toEqual([
        name,
        "Open in peek",
        ...peek.map((option) => option.label!),
      ]);
      const makeLeaf = menu.find(
        (element) =>
          element.getAttribute("data-content-action") === "make-leaf",
      )!;
      expect(makeLeaf.hasAttribute("data-disabled")).toBe(true);
      expect(makeLeaf.textContent?.includes("2")).toBe(true);
      await closeMenu();
    }
    detail = { form: "folder", subpageCount: 0, otherFileCount: 0 };
  });

  test("an item that is a nested Collection shows the Collection menu, like its Peek", async () => {
    const nested = page("plans/backlog/README.md", "Backlog");
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(nested, true));
      await openContextMenu(view.target(nested));
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
        (element) => element.getAttribute("data-content-action") === "new-item",
      )!;
      await act(async () => newItem.click());
      expect([name, ...calls]).toEqual([name, `new-item:${nested.path}`]);
    }
  });

  test("read-only items keep every action visible and leave only opening and pinning available", async () => {
    const peek = await peekMenuLabels(leaf, true);
    for (const [name, view] of Object.entries(views)) {
      await render(view.render(leaf), true);
      await openContextMenu(view.target(leaf));
      const menu = menuItems();
      expect([name, ...labels(menu)]).toEqual([
        name,
        "Open in peek",
        ...peek.map((option) => option.label!),
      ]);
      const enabled = menu
        .filter((element) => !element.hasAttribute("data-disabled"))
        .map((element) => element.textContent);
      expect([name, ...enabled]).toEqual([
        name,
        "Open in peek",
        "Pin",
        "Keep in Now",
      ]);
      await closeMenu();
    }
  });

  test("menu items open, duplicate, delete and run the item's operations", async () => {
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
        await openContextMenu(view.target(leaf));
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
    items = [leaf];
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
        onActivateItem={(item) => open(item)()}
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
      ...peek.map((option) => option.label!),
    ]);
    calls.length = 0;
    await act(async () => menuItems()[0]!.click());
    expect(calls).toEqual([`open:${leaf.path}`]);
  });
}
