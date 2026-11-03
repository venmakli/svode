import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Column } from "@/features/properties";
import type { Page } from "../model/types";
import type { PageMerge } from "../model/page-merge";

// The conflict mode of the property panel of a Page (DF-292 R3, R6, UX/UI
// contract): the line about the conflict, the mark and the variants of a
// disputed property in the display of its type, «Принять моё», «Принять
// входящее», an own value by the control, «Изменить», merged values read
// only, «Принять» with nothing disputed, read-only mode, a Page outside a
// Collection and the Page without a choice by properties.
if (process.env.SVODE_PAGE_PROPERTY_CONFLICT_DOM !== "1") {
  test("Page property panel conflict mode DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_PROPERTY_CONFLICT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  // Radix picks its layout effect by the presence of `document` at import.
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  installDomGlobals(dom);
  const document = dom.window.document;
  const { createRoot } = await import("react-dom/client");
  const { setLocale } = await import("@/paraglide/runtime.js");
  const m = await import("@/paraglide/messages.js");
  const { mockNativeIpc } = await import("@/platform/native/testing");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { PagePropertyPanel } = await import("./page-property-panel");
  const { PageMergeUnavailable } = await import("./page-merge-unavailable");
  const { getPageMergeState, setPageMerge, setPageMergeWrite } =
    await import("../model/page-merge");

  const SPACE = "/project";
  const PATH = "Задачи/Починить вход.md";
  const columns: Column[] = [
    {
      name: "Статус",
      type: "select",
      options: [
        { name: "Открыта", color: "blue" },
        { name: "Готово", color: "green" },
      ],
    },
    { name: "Исполнитель", type: "text" },
    { name: "Срок", type: "date" },
    { name: "Оценка", type: "number" },
  ];
  /** As the core reads a Page whose frontmatter is in conflict. */
  const source: Page = {
    path: PATH,
    body: "<<<<<<< ours\n...",
    meta: {
      title: "Починить вход",
      icon: null,
      created: "",
      updated: "",
      extra: {},
    },
    warnings: [{ kind: "malformed_frontmatter", message: "invalid YAML" }],
  };
  /**
   * «Починить вход»: «Статус» changed only by the incoming side merged on
   * its own, «Исполнитель» changed by both, «Срок» edited against a deletion.
   */
  const LOGIN: PageMerge = {
    type: "merged",
    body: "Описание задачи.\n",
    properties: [
      {
        key: "title",
        base: "Починить вход",
        ours: "Починить вход",
        theirs: "Починить вход",
        disputed: false,
        merged: "Починить вход",
      },
      {
        key: "Статус",
        base: "Открыта",
        ours: "Открыта",
        theirs: "Готово",
        disputed: false,
        merged: "Готово",
      },
      {
        key: "Исполнитель",
        base: "Анна",
        ours: "Борис",
        theirs: "Вера",
        disputed: true,
        merged: undefined,
      },
      {
        key: "Срок",
        base: "2026-11-01",
        ours: "2026-11-10",
        theirs: undefined,
        disputed: true,
        merged: undefined,
      },
    ],
  };

  mockNativeIpc((command) => {
    if (command === "git_conflict_file")
      return {
        path: PATH,
        kind: "page_properties",
        version: "x",
        content: null,
        places: { type: "unclear", reason: "ambiguous" },
        ours: true,
        theirs: true,
        binary: false,
        changes: null,
      };
    return null;
  });

  async function settle() {
    for (let index = 0; index < 5; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function mount({
    merge,
    schema = true,
    readOnly = false,
  }: {
    merge: PageMerge;
    schema?: boolean;
    readOnly?: boolean;
  }) {
    setPageMerge(SPACE, PATH, merge);
    const container = document.getElementById("app")!;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <PagePropertyPanel
            presentation="full"
            readOnly={readOnly}
            spacePath={SPACE}
            projectPath={SPACE}
            page={source}
            schemaResult={
              schema
                ? { collectionRootPath: "Задачи", schema: { columns } }
                : null
            }
            onValueChange={async () => {
              throw new Error("a field of a Page in conflict is not written");
            }}
          />
        </TooltipProvider>,
      );
      await settle();
    });
    return {
      container,
      async unmount() {
        await act(async () => root.unmount());
        setPageMerge(SPACE, PATH, null);
      },
    };
  }

  const row = (key: string) =>
    document.querySelector<HTMLElement>(
      `[data-collection-panel-property="${key}"]`,
    );
  const valueCell = (key: string) =>
    row(key)!.children[1] as HTMLElement | undefined;
  const summary = () =>
    document.querySelector("[data-collection-panel-conflict-summary]")
      ?.textContent ?? null;
  const variant = (key: string, side: "ours" | "theirs") =>
    row(key)!.querySelector<HTMLElement>(
      `[data-collection-panel-conflict-variant="${side}"]`,
    );
  const buttonIn = (root: ParentNode | null | undefined, text: string) =>
    Array.from(root?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === text,
    ) ?? null;
  async function click(target: Element | null) {
    expect(target === null).toBe(false);
    await act(async () => {
      (target as HTMLElement).click();
      await settle();
    });
  }
  async function type(target: HTMLInputElement, value: string) {
    await act(async () => {
      target.focus();
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  async function key(target: Element, name: string) {
    await act(async () => {
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, key: name }),
      );
      await settle();
    });
  }
  const decisions = () => getPageMergeState(SPACE, PATH)?.decisions;

  test("a disputed property shows its mark and the variants of both sides; merged values are read only", async () => {
    await setLocale("ru", { reload: false });
    const view = await mount({ merge: LOGIN });
    try {
      expect(summary()).toBe("Свойства изменили обе стороны · спорных: 2");
      // «Статус» changed only by the incoming side: merged, read only.
      expect(valueCell("Статус")!.textContent).toBe("Готово");
      expect(
        row("Статус")!.querySelector("[data-collection-panel-conflict-label]"),
      ).toBe(null);
      expect(
        row("Статус")!.querySelector("[data-collection-property-editor]"),
      ).toBe(null);
      // «Исполнитель» is disputed: the mark, its control and both variants.
      expect(
        row("Исполнитель")!
          .querySelector("[data-collection-panel-conflict-label] [aria-label]")!
          .getAttribute("aria-label"),
      ).toBe(m.changes_conflict_label());
      expect(
        row("Исполнитель")!.querySelector(
          "[data-collection-property-editor]",
        ) === null,
      ).toBe(false);
      expect(variant("Исполнитель", "ours")!.textContent).toBe(
        "Борис" + m.changes_conflict_accept_ours(),
      );
      expect(variant("Исполнитель", "theirs")!.textContent).toBe(
        "Вера" + m.changes_conflict_accept_theirs(),
      );
      // A side that removed the property says so.
      expect(variant("Срок", "theirs")!.textContent).toBe(
        "Удалено" + m.changes_conflict_accept_theirs(),
      );
      // An empty property without a dispute is not shown.
      expect(row("Оценка")).toBe(null);
      // The schema cannot be edited meanwhile.
      expect(
        document.body.textContent?.includes(m.collection_add_property()),
      ).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  test("a side, an own value by the control and «Изменить» decide a disputed property", async () => {
    await setLocale("ru", { reload: false });
    const view = await mount({ merge: LOGIN });
    try {
      await click(
        buttonIn(variant("Исполнитель", "theirs"), "Принять входящее"),
      );
      expect(decisions()).toEqual({ Исполнитель: { type: "theirs" } });
      expect(variant("Исполнитель", "ours")).toBe(null);
      expect(
        row("Исполнитель")!.querySelector<HTMLInputElement>("input")!.value,
      ).toBe("Вера");
      const decided = row("Исполнитель")!.querySelector(
        "[data-collection-panel-conflict-decided]",
      )!;
      expect(decided.textContent).toBe("Принято: входящееИзменить");
      expect(summary()).toBe("Свойства изменили обе стороны · спорных: 2");

      await click(buttonIn(decided, "Изменить"));
      expect(decisions()).toEqual({});
      expect(variant("Исполнитель", "ours") === null).toBe(false);

      // An own value by the control of the property decides it too.
      const input =
        row("Исполнитель")!.querySelector<HTMLInputElement>("input")!;
      await type(input, "Галина");
      await key(input, "Enter");
      expect(decisions()).toEqual({
        Исполнитель: { type: "value", value: "Галина" },
      });
      expect(
        row("Исполнитель")!.querySelector(
          "[data-collection-panel-conflict-decided]",
        )!.textContent,
      ).toBe("Принято: своё значениеИзменить");

      // Taking the side that removed the property leaves it without a value.
      await click(buttonIn(variant("Срок", "theirs"), "Принять входящее"));
      expect(decisions()).toEqual({
        Исполнитель: { type: "value", value: "Галина" },
        Срок: { type: "theirs" },
      });
    } finally {
      await view.unmount();
    }
  });

  test("a refused write is named at the panel and keeps the decisions", async () => {
    await setLocale("ru", { reload: false });
    const view = await mount({ merge: LOGIN });
    try {
      await click(buttonIn(variant("Исполнитель", "ours"), "Принять моё"));
      await act(async () => {
        setPageMergeWrite(SPACE, PATH, { status: "writing" });
        await settle();
      });
      expect(
        document
          .querySelector("[data-collection-panel-conflict]")!
          .textContent?.includes(m.property_saving()),
      ).toBe(true);
      await act(async () => {
        setPageMergeWrite(SPACE, PATH, {
          status: "refused",
          finding: { type: "unreadable", message: "bad date" },
        });
        await settle();
      });
      expect(
        document.querySelector('[data-conflict-problem="unreadable"]') === null,
      ).toBe(false);
      expect(decisions()).toEqual({ Исполнитель: { type: "ours" } });
    } finally {
      await view.unmount();
    }
  });

  test("with nothing disputed the merged properties are taken by «Принять»", async () => {
    await setLocale("ru", { reload: false });
    const merge: PageMerge = {
      type: "merged",
      body: "",
      properties: [
        {
          key: "Статус",
          base: "Открыта",
          ours: "Открыта",
          theirs: "Готово",
          disputed: false,
          merged: "Готово",
        },
        {
          key: "Исполнитель",
          base: "Анна",
          ours: "Вера",
          theirs: "Анна",
          disputed: false,
          merged: "Вера",
        },
      ],
    };
    const view = await mount({ merge });
    try {
      expect(summary()).toBe(
        "Обе стороны меняли разные свойства — изменения объединены",
      );
      expect(valueCell("Статус")!.textContent).toBe("Готово");
      expect(valueCell("Исполнитель")!.textContent).toBe("Вера");
      expect(document.querySelector("[data-collection-property-editor]")).toBe(
        null,
      );
      await click(
        buttonIn(
          document.querySelector("[data-collection-panel-conflict]"),
          "Принять",
        ),
      );
      expect(getPageMergeState(SPACE, PATH)?.accepted).toBe(true);
      const line = document.querySelector("[data-collection-panel-conflict]")!;
      expect(buttonIn(line, "Принять")).toBe(null);
      await click(buttonIn(line, "Изменить"));
      expect(getPageMergeState(SPACE, PATH)?.accepted).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  test("read only shows the variants without actions", async () => {
    await setLocale("ru", { reload: false });
    const view = await mount({ merge: LOGIN, readOnly: true });
    try {
      expect(variant("Исполнитель", "ours")!.textContent).toBe(
        "Борис" + m.changes_conflict_accept_ours(),
      );
      expect(
        buttonIn(variant("Исполнитель", "ours"), "Принять моё")!.disabled,
      ).toBe(true);
      expect(document.querySelector("[data-collection-property-editor]")).toBe(
        null,
      );
    } finally {
      await view.unmount();
    }
  });

  test("a Page outside a Collection shows its disputed title in the panel", async () => {
    await setLocale("en", { reload: false });
    const merge: PageMerge = {
      type: "merged",
      body: "",
      properties: [
        {
          key: "title",
          base: "Plan",
          ours: "Plan Q4",
          theirs: "Plan 2026",
          disputed: true,
          merged: undefined,
        },
        {
          key: "tags",
          base: ["a"],
          ours: ["a", "b"],
          theirs: ["a"],
          disputed: false,
          merged: ["a", "b"],
        },
      ],
    };
    const view = await mount({ merge, schema: false });
    try {
      expect(summary()).toBe(m.property_conflict_summary({ count: "1" }));
      expect(row("title")!.children[0]!.textContent).toBe(
        m.page_merge_key_title(),
      );
      expect(variant("title", "ours")!.textContent).toBe(
        "Plan Q4" + m.changes_conflict_accept_ours(),
      );
      await click(
        buttonIn(
          variant("title", "theirs"),
          m.changes_conflict_accept_theirs(),
        ),
      );
      expect(decisions()).toEqual({ title: { type: "theirs" } });
      expect(valueCell("title")!.textContent).toBe(
        "Plan 2026" +
          m.changes_conflict_accepted_theirs() +
          m.changes_conflict_change_choice(),
      );
    } finally {
      await view.unmount();
    }
  });

  test("a Page without a choice by properties offers a side for the whole file", async () => {
    await setLocale("ru", { reload: false });
    const container = document.getElementById("app")!;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PageMergeUnavailable
          spacePath={SPACE}
          path={PATH}
          reason={{ type: "unreadable", stage: "theirs", message: "bad YAML" }}
          readOnly={false}
        />,
      );
      await settle();
    });
    try {
      const alert = container.querySelector("[data-page-merge-unavailable]")!;
      expect(alert.textContent?.includes("Свойства не выбрать по одному")).toBe(
        true,
      );
      expect(
        alert.textContent?.includes(
          "Свойства входящей версии не читаются: bad YAML",
        ),
      ).toBe(true);
      expect(buttonIn(alert, m.changes_conflict_keep_ours()) === null).toBe(
        false,
      );
      expect(buttonIn(alert, m.changes_conflict_take_theirs()) === null).toBe(
        false,
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
  ]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, method, {
      configurable: true,
      value: () => false,
    });
  }
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
    HTMLButtonElement: dom.window.HTMLButtonElement,
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
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
