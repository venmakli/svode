import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { DndContext } from "@dnd-kit/core";

import { Table, TableBody, TableCell } from "@/components/ui/table";
import { TitleCell } from "./cells";
import { SortableTableRow } from "./table-row";

test("collection title cells show the current path only for external name conflicts", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TitleCell
          row={{
            entry: {
              meta: {
                title: "Shared",
                icon: null,
                created: "",
                updated: "",
                extra: {},
              },
              body: "",
              path: "collection/one.md",
              name_conflict: {
                parentPath: "collection",
                conflicts: [{ path: "collection/two.md", title: "shared" }],
              },
            },
            level: 0,
            child: false,
            nestedCollection: false,
          }}
          showIcon={false}
          expandable={false}
          expanded={false}
          nested={false}
          onToggle={() => undefined}
          onOpenNested={() => undefined}
        />,
      );
    });

    expect(
      dom.window.document.querySelector("[data-page-name-conflict-path]")
        ?.textContent,
    ).toBe("collection/one.md");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("collection Table rows select visibly and open the same peek from double-click and Enter", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  let openCount = 0;
  let nestedCount = 0;
  const root = createRoot(dom.window.document.getElementById("app")!);

  function Harness() {
    const [selected, setSelected] = useState(false);
    return (
      <DndContext>
        <Table>
          <TableBody>
            <SortableTableRow
              disabled
              readOnly
              registerRow={() => undefined}
              row={{
                child: false,
                entry: {
                  body: "",
                  meta: {
                    created: "",
                    extra: {},
                    icon: null,
                    title: "Roadmap",
                    updated: "",
                  },
                  path: "collection/roadmap.md",
                },
                level: 0,
                nestedCollection: false,
              }}
              rowHeightClassName="h-9"
              selected={selected}
              tabIndex={0}
              onDelete={() => undefined}
              onDuplicate={() => undefined}
              onFocus={() => setSelected(true)}
              onMoveFocus={() => undefined}
              onOpen={() => {
                openCount += 1;
              }}
            >
              <TableCell>
                <TitleCell
                  row={{
                    child: false,
                    entry: {
                      body: "",
                      meta: {
                        created: "",
                        extra: {},
                        icon: null,
                        title: "Roadmap",
                        updated: "",
                      },
                      path: "collection/roadmap.md",
                    },
                    level: 0,
                    nestedCollection: false,
                  }}
                  showIcon={false}
                  expandable={false}
                  expanded={false}
                  nested={false}
                  onToggle={() => undefined}
                  onOpenNested={() => undefined}
                />
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  onClick={() => {
                    nestedCount += 1;
                  }}
                >
                  Nested control
                </button>
              </TableCell>
            </SortableTableRow>
          </TableBody>
        </Table>
      </DndContext>
    );
  }

  try {
    await act(async () => root.render(<Harness />));
    const row = dom.window.document.querySelector<HTMLElement>(
      '[data-table-row-path="collection/roadmap.md"]',
    )!;
    const title = row.querySelector<HTMLElement>("[data-collection-primary]")!;
    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.className.includes("bg-muted")).toBe(true);
    expect(openCount).toBe(1);

    await act(async () => {
      row.dispatchEvent(
        new dom.window.MouseEvent("dblclick", { bubbles: true }),
      );
      row.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });
    expect(openCount).toBe(3);

    const nested = Array.from(row.querySelectorAll("button")).find(
      (button) => button.textContent === "Nested control",
    )!;
    await act(async () => nested.click());
    expect(nestedCount).toBe(1);
    expect(openCount).toBe(3);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
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
    IS_REACT_ACT_ENVIRONMENT: true,
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
