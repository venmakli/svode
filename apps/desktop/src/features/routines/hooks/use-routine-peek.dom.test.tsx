import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { JSDOM } from "jsdom";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import type { CollectionActionState } from "@/features/collection";
import type { CollectionItemPeekController } from "@/features/collection/app-shell";

import type { RoutineDefinition, RoutineItem } from "../model/types";
import type { RoutineTitleFocus } from "./use-routine-peek";

const executors: AgentActorOptionsState = {
  ambiguous: [],
  error: null,
  incomplete: false,
  loading: false,
  options: [],
};
const routine: RoutineItem = {
  definition: {
    action: { executor: "agent:docs", type: "run_agent" },
    body: "Review changes.",
    description: "Review the current owner.",
    enabled: false,
    name: "Daily summary",
    trigger: { type: "manual" },
  },
  definitionPath: ".routines/daily-summary.md",
  description: "Review the current owner.",
  diagnostics: [],
  filename: "daily-summary.md",
  fingerprint: "fingerprint:1",
  id: "routine:summary",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  name: "Daily summary",
  nextRunAt: null,
  routineId: "routine:summary",
  valid: true,
};

function renamed(name: string): RoutineItem {
  return {
    ...routine,
    definition: { ...routine.definition!, name },
    fingerprint: `fingerprint:${name}`,
    name,
  };
}

if (process.env.SVODE_ROUTINE_PEEK_DOM !== "1") {
  test("routine peek DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINE_PEEK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><button id=row>Daily summary</button></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    HTMLCollection: dom.window.HTMLCollection,
    NodeList: dom.window.NodeList,
    ShadowRoot: dom.window.ShadowRoot,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    SVGElement: dom.window.SVGElement,
    DOMRect: dom.window.DOMRect,
    FocusEvent: dom.window.FocusEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
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
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const doc = dom.window.document;

  interface Controls {
    peek?: CollectionItemPeekController<string>;
    setItems?: (items: readonly RoutineItem[] | null) => void;
    setRunState?: (state: CollectionActionState) => void;
    setTitleFocus?: (focus: RoutineTitleFocus | null) => void;
  }

  interface Write {
    definition: RoutineDefinition;
    materializeFilename: boolean;
  }

  async function setup() {
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionItemPeek, useCollectionItemPeek } =
      await import("@/features/collection/app-shell");
    const { createRoutinesPresentation } =
      await import("../ui/routines-presentation");
    const { useRoutinePeek } = await import("./use-routine-peek");
    // React DOM checks for input events when it loads, after the DOM.
    const { createRoot } = await import("react-dom/client");
    const controls: Controls = {};
    const writes: Write[] = [];
    const enabledWrites: boolean[] = [];

    function Harness() {
      const [items, setItems] = useState<readonly RoutineItem[] | null>([
        routine,
      ]);
      const [runState, setRunState] = useState<CollectionActionState>({
        status: "idle",
      });
      const [titleFocus, setTitleFocus] = useState<RoutineTitleFocus | null>(
        null,
      );
      const peek = useCollectionItemPeek<string>((id) => id);
      const writeProperty = async (
        item: RoutineItem,
        change: (definition: RoutineDefinition) => RoutineDefinition,
        options: { materializeFilename?: boolean } = {},
      ) => {
        const definition = change(item.definition!);
        writes.push({
          definition,
          materializeFilename: options.materializeFilename ?? false,
        });
        const updated: RoutineItem = {
          ...item,
          definition,
          description: definition.description,
          fingerprint: `${item.fingerprint}+`,
          name: definition.name,
        };
        setItems((current) =>
          (current ?? []).map((candidate) =>
            candidate.id === item.id ? updated : candidate,
          ),
        );
        return updated;
      };
      const routinePeek = useRoutinePeek({
        getRunRefusal: () => null,
        getRunState: () => runState,
        items,
        onOpenSession: () => undefined,
        onRun: async () => undefined,
        readOnly: false,
        recovery: {},
        titleFocus,
        writeProperty,
      });
      const idle = { status: "idle" } as const;
      const presentation = createRoutinesPresentation({
        ownership: { collection: null, space: "Project" },
        actions: {
          createState: idle,
          getDeleteState: () => idle,
          getDefinitionEditState: () => idle,
          getEnabledState: () => idle,
          getRunState: () => runState,
          onAdd: () => undefined,
          onDelete: () => undefined,
          onEnabledChange: async (item, enabled) => {
            enabledWrites.push(enabled);
            setItems([
              {
                ...item,
                definition: { ...item.definition!, enabled },
                fingerprint: `${item.fingerprint}:enabled`,
              },
            ]);
          },
          onRun: async () => undefined,
          writeDefinition: async (item, change) => {
            await writeProperty(item, change);
          },
        },
        executors,
        state: items ? { items, phase: "ready" } : { phase: "initial" },
      });
      useEffect(() => {
        Object.assign(controls, {
          peek,
          setItems,
          setRunState,
          setTitleFocus,
        });
      }, [peek]);
      return (
        <CollectionItemPeek
          peek={peek}
          find={routinePeek.find}
          render={(item) => routinePeek.render(item, presentation)}
        />
      );
    }

    const root = createRoot(doc.body.appendChild(doc.createElement("div")));
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Harness />
        </TooltipProvider>,
      );
    });
    return { controls, enabledWrites, root, writes };
  }

  async function run(action: () => unknown) {
    await act(async () => {
      await action();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  const topBar = () => doc.querySelector<HTMLElement>("[data-peek-top-bar]");
  const identity = () =>
    doc.querySelector("[data-peek-identity] [title]")?.textContent ?? null;
  const menu = () =>
    topBar()?.querySelector('[aria-label="Row actions"]') ?? null;
  const peekOpen = () => doc.querySelector("[data-collection-item-peek]");
  const button = (label: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    ) ?? null;
  const title = () =>
    doc.querySelector<HTMLTextAreaElement>(
      "[data-object-content-header-title]",
    )!;
  const titleMessage = () =>
    doc.querySelector('[data-object-content-header-message="title"]')
      ?.textContent ?? null;

  /** Types `value` into a text field as a user does. */
  function type(field: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    field.focus();
    setter.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  function press(field: HTMLElement, key: string) {
    field.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }),
    );
  }

  test("a Routine opens with identity, ⋯ and Run now in the top bar, its name and description in place, and follows its item", async () => {
    const { controls, root } = await setup();
    await run(() =>
      controls.peek!.open(routine.id, {
        returnFocus: () => doc.getElementById("row"),
      }),
    );
    expect(identity()).toBe("Daily summary");
    expect(menu() === null).toBe(false);
    expect(
      topBar()?.querySelector("[data-routine-run-tool]")?.textContent,
    ).toBe("Run now");
    expect(title().value).toBe("Daily summary");
    expect(
      doc.querySelector<HTMLTextAreaElement>(
        "[data-object-content-header-description]",
      )?.value,
    ).toBe("Review the current owner.");
    // No form: no footer, no Save, no owner line.
    expect(doc.querySelector(".border-t")).toBeNull();
    expect(button("Save")).toBeNull();
    expect(doc.querySelector("[data-routine-instruction]") === null).toBe(
      false,
    );

    // An external edit and a new run state draw in place.
    const scroll = doc.querySelector("[data-collection-item-peek-scroll]");
    await run(() => controls.setItems!([renamed("Weekly summary")]));
    expect(identity()).toBe("Weekly summary");
    expect(title().value).toBe("Weekly summary");
    expect(doc.querySelector("[data-collection-item-peek-scroll]")).toBe(
      scroll,
    );
    expect(menu() === null).toBe(false);
    await run(() => controls.setRunState!({ status: "pending" }));
    expect(
      topBar()?.querySelector("[data-routine-run-tool]")?.textContent,
    ).toBe("Starting…");
    await run(() => controls.setRunState!({ status: "idle" }));

    // Loading keeps the Routine as it is.
    await run(() => controls.setItems!(null));
    expect(identity()).toBe("Weekly summary");
    await run(() => controls.setItems!([renamed("Weekly summary")]));

    // An external delete closes the Routine and focus returns to its row.
    await run(() => controls.setItems!([]));
    await run(() => undefined);
    expect(peekOpen()).toBeNull();
    expect(doc.activeElement?.id).toBe("row");

    // Opened by an addressed request, it follows the catalog too.
    await run(() => controls.setItems!([routine]));
    await run(() => controls.peek!.open(routine.id));
    expect(identity()).toBe("Daily summary");
    expect(menu() === null).toBe(false);
    await run(() => controls.setItems!([renamed("Nightly summary")]));
    expect(identity()).toBe("Nightly summary");
    // A Routine that lost its id is a Routine that is gone.
    await run(() =>
      controls.setItems!([
        { ...routine, id: "invalid:.routines/daily-summary.md" },
      ]),
    );
    expect(peekOpen()).toBeNull();
    await act(async () => root.unmount());
  }, 30000);

  test("the name is saved at once with its file renamed; a taken or empty name is refused at the name and nothing is written", async () => {
    const { controls, root, writes } = await setup();
    const weekly: RoutineItem = {
      ...renamed("Weekly"),
      definitionPath: ".routines/weekly.md",
      filename: "weekly.md",
      id: "routine:weekly",
      routineId: "routine:weekly",
    };
    await run(() => controls.setItems!([routine, weekly]));
    await run(() => controls.peek!.open(routine.id));

    await run(() => type(title(), "weekly"));
    await run(() => press(title(), "Enter"));
    await run(() => title().blur());
    expect(writes).toEqual([]);
    expect(titleMessage()).toBe(
      "This name is already used in this owner by .routines/weekly.md. Choose a unique name.",
    );
    expect(title().value).toBe("Daily summary");

    await run(() => type(title(), "   "));
    await run(() => title().blur());
    expect(writes).toEqual([]);
    expect(titleMessage()).toBe("Name is required");
    expect(title().value).toBe("Daily summary");

    await run(() => type(title(), "Evening summary"));
    await run(() => press(title(), "Enter"));
    await run(() => title().blur());
    expect(writes.map((write) => write.definition.name)).toEqual([
      "Evening summary",
    ]);
    expect(writes[0]!.materializeFilename).toBe(true);
    expect(titleMessage()).toBeNull();
    expect(identity()).toBe("Evening summary");
    expect(menu() === null).toBe(false);

    // The description is saved the same way.
    const description = () =>
      doc.querySelector<HTMLTextAreaElement>(
        "[data-object-content-header-description]",
      )!;
    await run(() => type(description(), "Summarize the evening."));
    await run(() => press(description(), "Enter"));
    await run(() => description().blur());
    expect(writes.at(-1)?.definition.description).toBe(
      "Summarize the evening.",
    );
    expect(writes.at(-1)?.materializeFilename).toBe(false);

    // Escape puts the saved name back without writing.
    await run(() => type(title(), "Discarded"));
    await run(() => press(title(), "Escape"));
    expect(writes.length).toBe(2);
    expect(title().value).toBe("Evening summary");
    expect(peekOpen() === null).toBe(false);
    await act(async () => root.unmount());
  }, 30000);

  test("a new Routine opens with its name focused and selected", async () => {
    const { controls, root } = await setup();
    await run(() => controls.peek!.open(routine.id));
    expect(doc.activeElement === title()).toBe(false);
    await run(() =>
      controls.setTitleFocus!({ itemId: routine.id, request: 1 }),
    );
    await run(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const focused = doc.activeElement as HTMLTextAreaElement | null;
    expect(focused?.hasAttribute("data-object-content-header-title")).toBe(
      true,
    );
    expect(focused?.selectionStart).toBe(0);
    expect(focused?.selectionEnd).toBe("Daily summary".length);
    await act(async () => root.unmount());
  }, 30000);

  test("a Routine shows its properties in the property panel, where Enabled is switched and saved at once, with ⋯ in place", async () => {
    const { controls, enabledWrites, root } = await setup();
    const scheduled: RoutineItem = {
      ...routine,
      definition: {
        ...routine.definition!,
        trigger: {
          cron: "0 9 * * *",
          missedRuns: "skip",
          timeBasis: { mode: "local" },
          type: "schedule",
        },
      },
    };
    await run(() => controls.setItems!([scheduled]));
    await run(() => controls.peek!.open(scheduled.id));
    const panel = doc.querySelector("[data-collection-property-panel]");
    expect(panel === null).toBe(false);
    expect(
      [...panel!.querySelectorAll("[data-collection-panel-property]")].map(
        (row) => row.getAttribute("data-collection-panel-property"),
      ),
    ).toEqual(["space", "trigger", "action", "executor", "enabled"]);
    // "Name" is the header's; the empty run dates are not shown.
    expect(panel!.textContent?.includes("Daily summary")).toBe(false);
    const toggle = () =>
      doc.querySelector<HTMLButtonElement>(
        '[data-collection-property-editor="enabled"] [role="switch"]',
      )!;
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await run(() => toggle().click());
    expect(enabledWrites).toEqual([true]);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(menu() === null).toBe(false);
    await act(async () => root.unmount());
  });

  test("Trigger is edited in its popover and saved whole when it closes", async () => {
    const { controls, root, writes } = await setup();
    const scheduled: RoutineItem = {
      ...routine,
      definition: {
        ...routine.definition!,
        trigger: {
          cron: "0 9 * * *",
          missedRuns: "skip",
          timeBasis: { mode: "local" },
          type: "schedule",
        },
      },
    };
    await run(() => controls.setItems!([scheduled]));
    await run(() => controls.peek!.open(scheduled.id));
    const triggerButton = () =>
      doc.querySelector<HTMLButtonElement>(
        '[data-collection-property-editor="trigger"] button',
      )!;
    await run(() => triggerButton().click());
    const popover = doc.querySelector(
      '[data-collection-property-popover="trigger"]',
    );
    expect(popover === null).toBe(false);
    const time =
      popover!.querySelector<HTMLInputElement>('input[type="time"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await run(() => {
      setter.call(time, "10:30");
      time.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    // Nothing is written while the popover is open.
    expect(writes).toEqual([]);
    await run(() => triggerButton().click());
    expect(
      doc.querySelector('[data-collection-property-popover="trigger"]'),
    ).toBeNull();
    expect(writes.map((write) => write.definition.trigger)).toEqual([
      {
        cron: "30 10 * * *",
        missedRuns: "skip",
        timeBasis: { mode: "local" },
        type: "schedule",
      },
    ]);
    expect(peekOpen() === null).toBe(false);
    await act(async () => root.unmount());
  }, 30000);
}
