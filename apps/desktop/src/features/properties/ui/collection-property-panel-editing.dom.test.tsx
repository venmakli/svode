import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CollectionPropertyDefinition } from "../model/collection-property";

// Editing in the property panel (Stage 11 `04`, 4.F): order, hidden and
// empty properties, immediate saving by each kind of control, Escape,
// waiting, a refused write, a version conflict, an update from disk while
// editing and an invalid draft of a composite popover.
if (process.env.SVODE_PROPERTY_PANEL_EDITING_DOM !== "1") {
  test("property panel editing DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PROPERTY_PANEL_EDITING_DOM: "1" },
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
  const { createRoot } = await import("react-dom/client");
  const { setLocale } = await import("@/paraglide/runtime.js");
  await setLocale("en", { reload: false });
  const {
    defineComputedCollectionProperty,
    defineOwnerDefinedCollectionProperty,
  } = await import("../model/collection-property");
  const { defineTitleCollectionProperty } =
    await import("../model/common-property");
  const { CollectionPropertyPanel } =
    await import("./collection-property-panel");
  const { keepsCollectionPropertyEditorOnEscape } =
    await import("./collection-property-editor");
  const document = dom.window.document;

  interface Task {
    title: string;
    summary: string | null;
    stage: string | null;
    done: boolean;
    owner: string | null;
    note: string | null;
    secret: boolean;
    schedule: string;
  }

  const saved: Task = {
    done: false,
    note: null,
    owner: null,
    schedule: "daily",
    secret: false,
    stage: null,
    summary: "Review",
    title: "Task one",
  };

  type Update = (key: keyof Task, value: unknown) => Promise<void>;

  function properties(
    update: Update,
  ): readonly CollectionPropertyDefinition<Task>[] {
    const edit = (key: keyof Task) => ({
      getState: () => ({ status: "idle" as const }),
      update: (_item: Task, value: unknown) => update(key, value),
    });
    return [
      defineTitleCollectionProperty<Task>({ getValue: (item) => item.title }),
      defineOwnerDefinedCollectionProperty<Task>({
        capabilities: {
          edit: {
            ...edit("summary"),
            validate: (value) =>
              value === "bad" ? "Summary cannot be bad" : null,
          },
        },
        featureId: "test",
        getValue: (item) => item.summary,
        key: "summary",
        label: "Summary",
        standard: { type: "text" },
      }),
      defineComputedCollectionProperty<Task>({
        featureId: "test",
        getValue: (item) => item.owner,
        key: "owner",
        label: "Owner",
        standard: { type: "text" },
      }),
      defineOwnerDefinedCollectionProperty<Task>({
        capabilities: { edit: edit("stage") },
        featureId: "test",
        getValue: (item) => item.stage,
        key: "stage",
        label: "Stage",
        standard: {
          options: [
            { color: "blue", name: "Todo" },
            { color: "green", name: "Done" },
          ],
          type: "select",
        },
      }),
      {
        ...defineOwnerDefinedCollectionProperty<Task>({
          featureId: "test",
          getValue: () => "x",
          key: "secret",
          label: "Secret",
          standard: { type: "text" },
        }),
        getApplicability: (item: Task) =>
          item.secret ? { status: "applicable" } : { status: "hidden" },
      },
      defineOwnerDefinedCollectionProperty<Task>({
        capabilities: { edit: edit("done") },
        featureId: "test",
        getValue: (item) => item.done,
        key: "done",
        label: "Done",
        standard: { display: "switch", type: "boolean" },
      }),
      defineOwnerDefinedCollectionProperty<Task>({
        capabilities: { edit: edit("note") },
        featureId: "test",
        getValue: (item) => item.note,
        key: "note",
        label: "Note",
        standard: { type: "text" },
      }),
      defineOwnerDefinedCollectionProperty<Task>({
        capabilities: {
          edit: {
            ...edit("schedule"),
            popover: {
              render: ({ draft, onDraftChange }) => (
                <input
                  aria-label="Schedule draft"
                  value={String(draft ?? "")}
                  onChange={(event) => onDraftChange(event.target.value)}
                />
              ),
            },
            validate: (value) =>
              value === "never" ? "A schedule must run" : null,
          },
        },
        featureId: "test",
        getValue: (item) => item.schedule,
        key: "schedule",
        label: "Schedule",
        standard: { type: "text" },
      }),
    ];
  }

  interface Mounted {
    root: Root;
    setItem(item: Task): void;
    item(): Task;
  }

  async function mount(update: Update, initial: Task = saved) {
    const container = document.getElementById("app")!;
    const controls: Partial<Mounted> = {};
    function Harness() {
      const [item, setItem] = useState(initial);
      const itemRef = useRef(item);
      useEffect(() => {
        itemRef.current = item;
        Object.assign(controls, { item: () => itemRef.current, setItem });
      }, [item]);
      return (
        <CollectionPropertyPanel item={item} properties={properties(update)} />
      );
    }
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    return { ...controls, root } as Mounted;
  }

  async function unmount(mounted: Mounted) {
    await act(async () => mounted.root.unmount());
  }

  function row(key: string) {
    return document.querySelector<HTMLElement>(
      `[data-collection-property-editor="${key}"]`,
    )!;
  }

  function input(key: string) {
    return row(key).querySelector<HTMLInputElement>("input")!;
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

  async function click(target: Element) {
    await act(async () => {
      target.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      (target as HTMLElement).click();
      await settle();
    });
  }

  function message(key: string) {
    return (
      row(key).querySelector("[data-collection-panel-property-message]")
        ?.textContent ?? null
    );
  }

  function state(key: string) {
    return row(key).getAttribute("data-collection-panel-property-state");
  }

  test("properties follow their declaration without Name, hidden and empty read-only ones; an empty editable one shows its hint", async () => {
    const mounted = await mount(async () => undefined);
    try {
      const keys = [
        ...document.querySelectorAll("[data-collection-panel-property]"),
      ].map((element) =>
        element.getAttribute("data-collection-panel-property"),
      );
      expect(keys).toEqual(["summary", "stage", "done", "note", "schedule"]);
      expect(input("note").placeholder).toBe("Empty");
      expect(row("stage").textContent).toBe("Empty");
      expect(document.body.textContent?.includes("Task one")).toBe(false);
      expect(
        document.body.textContent?.includes("+ Add property") ||
          document.body.textContent?.includes("Add property"),
      ).toBe(false);
    } finally {
      await unmount(mounted);
    }
  });

  test("text saves on Enter and on leaving a changed field; select saves the chosen option; a switch saves when toggled", async () => {
    const writes: [string, unknown][] = [];
    const mounted = await mount(async (key, value) => {
      writes.push([key, value]);
      mounted.setItem({ ...mounted.item(), [key]: value });
    });
    try {
      await type(input("summary"), "Ship it");
      await key(input("summary"), "Enter");
      expect(writes).toEqual([["summary", "Ship it"]]);

      // Leaving an unchanged field writes nothing.
      await act(async () => {
        input("note").focus();
        input("note").blur();
      });
      expect(writes.length).toBe(1);

      await type(input("note"), "Later");
      await act(async () => input("note").blur());
      expect(writes[1]).toEqual(["note", "Later"]);

      const trigger = row("stage").querySelector("button")!;
      await key(trigger, "Enter");
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((item) => item.textContent?.includes("Done"))!;
      await click(option);
      expect(writes[2]).toEqual(["stage", "Done"]);

      await click(row("done").querySelector('[role="switch"]')!);
      expect(writes[3]).toEqual(["done", true]);
      expect(
        row("done")
          .querySelector('[role="switch"]')!
          .getAttribute("aria-checked"),
      ).toBe("true");
    } finally {
      await unmount(mounted);
    }
  });

  test("Escape puts the saved value back without writing and keeps the surrounding peek open", async () => {
    const writes: unknown[] = [];
    const mounted = await mount(async (_key, value) => {
      writes.push(value);
    });
    try {
      await type(input("summary"), "Draft");
      expect(keepsCollectionPropertyEditorOnEscape(input("summary"))).toBe(
        true,
      );
      expect(keepsCollectionPropertyEditorOnEscape(document.body)).toBe(false);
      await key(input("summary"), "Escape");
      expect(input("summary").value).toBe("Review");
      expect(writes).toEqual([]);
    } finally {
      await unmount(mounted);
    }
  });

  test("a property waits while it is written and its neighbours stay available", async () => {
    let finish: () => void = () => undefined;
    const mounted = await mount(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    try {
      await click(row("done").querySelector('[role="switch"]')!);
      expect(state("done")).toBe("pending");
      expect(row("done").getAttribute("aria-busy")).toBe("true");
      expect(
        row("done").querySelector<HTMLButtonElement>('[role="switch"]')!
          .disabled,
      ).toBe(true);
      expect(
        row("done").querySelector(
          "[data-collection-panel-property-pending]",
        ) === null,
      ).toBe(false);
      expect(input("summary").disabled).toBe(false);
      expect(state("summary")).toBe("idle");
      await act(async () => {
        finish();
        await settle();
      });
      expect(state("done")).toBe("idle");
    } finally {
      await unmount(mounted);
    }
  });

  test("a refused write shows the saved value and its reason at the property, without a toast", async () => {
    const mounted = await mount(async () => {
      throw new Error("The repository is read-only");
    });
    try {
      await type(input("summary"), "Ship it");
      await key(input("summary"), "Enter");
      expect(input("summary").value).toBe("Review");
      expect(message("summary")).toBe("The repository is read-only");
      expect(state("summary")).toBe("error");
      expect(
        row("summary")
          .querySelector("[data-collection-panel-property-message]")!
          .getAttribute("role"),
      ).toBe("alert");
      expect(document.querySelector("[data-sonner-toast]")).toBeNull();
      expect(message("note")).toBeNull();
    } finally {
      await unmount(mounted);
    }
  });

  test("a version conflict shows the values from disk and the reason at the property", async () => {
    const mounted = await mount(async () => {
      // The owner reads the item again before it refuses the write.
      mounted.setItem({ ...mounted.item(), stage: "Todo", summary: "Disk" });
      throw new Error("The task changed on disk");
    });
    try {
      await type(input("summary"), "Mine");
      await key(input("summary"), "Enter");
      expect(input("summary").value).toBe("Disk");
      expect(row("stage").textContent?.includes("Todo")).toBe(true);
      expect(message("summary")).toBe("The task changed on disk");
    } finally {
      await unmount(mounted);
    }
  });

  test("an update from disk while editing keeps the open editor and shows the other new values", async () => {
    const writes: unknown[] = [];
    const mounted = await mount(async (_key, value) => {
      writes.push(value);
    });
    try {
      await type(input("summary"), "Mine");
      await act(async () =>
        mounted.setItem({
          ...mounted.item(),
          note: "From disk",
          summary: "Disk",
        }),
      );
      await act(async () => settle());
      expect(input("summary").value).toBe("Mine");
      expect(dom.window.document.activeElement).toBe(input("summary"));
      expect(input("note").value).toBe("From disk");
      expect(writes).toEqual([]);
    } finally {
      await unmount(mounted);
    }
  });

  test("an invalid value is not written and shows at the property", async () => {
    const writes: unknown[] = [];
    const mounted = await mount(async (_key, value) => {
      writes.push(value);
    });
    try {
      await type(input("summary"), "bad");
      await key(input("summary"), "Enter");
      expect(writes).toEqual([]);
      expect(message("summary")).toBe("Summary cannot be bad");
      expect(state("summary")).toBe("invalid");
      expect(input("summary").value).toBe("bad");
      expect(input("summary").getAttribute("aria-invalid")).toBe("true");
    } finally {
      await unmount(mounted);
    }
  });

  test("a composite popover checks its draft inside, drops it on Escape, drops an invalid one with Change not saved and saves a valid one whole on close", async () => {
    const writes: [string, unknown][] = [];
    const mounted = await mount(async (key, value) => {
      writes.push([key, value]);
      mounted.setItem({ ...mounted.item(), [key]: value });
    });
    const trigger = () => row("schedule").querySelector("button")!;
    const draft = () =>
      document.querySelector<HTMLInputElement>('[aria-label="Schedule draft"]');
    try {
      expect(trigger().textContent).toBe("daily");

      await click(trigger());
      expect(draft()!.value).toBe("daily");
      await type(draft()!, "never");
      expect(
        document.querySelector("[data-collection-property-popover-problem]")
          ?.textContent,
      ).toBe("A schedule must run");
      await key(draft()!, "Escape");
      expect(draft()).toBeNull();
      expect(writes).toEqual([]);
      expect(message("schedule")).toBeNull();

      await click(trigger());
      await type(draft()!, "never");
      await click(trigger());
      expect(draft()).toBeNull();
      expect(writes).toEqual([]);
      expect(message("schedule")).toBe("Change not saved: A schedule must run");
      expect(trigger().textContent).toBe("daily");

      await click(trigger());
      expect(message("schedule")).toBeNull();
      await type(draft()!, "weekly");
      await click(trigger());
      expect(writes).toEqual([["schedule", "weekly"]]);
      expect(trigger().textContent).toBe("weekly");
    } finally {
      await unmount(mounted);
    }
  });

  function settle() {
    return new Promise<void>((resolve) =>
      dom.window.setTimeout(
        () => dom.window.requestAnimationFrame(() => resolve()),
        0,
      ),
    );
  }
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
