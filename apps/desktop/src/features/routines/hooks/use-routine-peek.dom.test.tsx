import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import type { CollectionActionState } from "@/features/collection";
import type { CollectionItemPeekController } from "@/features/collection/app-shell";

import type { RoutineItem } from "../model/types";
import type { RoutineEditSession } from "./use-routine-mutations";

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
    setEditSession?: (session: RoutineEditSession | null) => void;
    setItems?: (items: readonly RoutineItem[] | null) => void;
    setRunState?: (state: CollectionActionState) => void;
  }

  async function setup() {
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionItemPeek, useCollectionItemPeek } =
      await import("@/features/collection/app-shell");
    const { createRoutinesPresentation } =
      await import("../ui/routines-presentation");
    const { useRoutinePeek } = await import("./use-routine-peek");
    const controls: Controls = {};
    const saved: RoutineItem[] = [];

    function Harness() {
      const [items, setItems] = useState<readonly RoutineItem[] | null>([
        routine,
      ]);
      const [runState, setRunState] = useState<CollectionActionState>({
        status: "idle",
      });
      const [editSession, setEditSession] = useState<RoutineEditSession | null>(
        null,
      );
      const peek = useCollectionItemPeek<string>((id) => id);
      const routinePeek = useRoutinePeek({
        applyUpdate: async (item, definition) => {
          const updated = { ...item, ...renamed(definition.name) };
          saved.push(updated);
          setItems([updated]);
          return updated;
        },
        editSession,
        executors,
        getRunRefusal: () => null,
        getRunState: () => runState,
        mutationError: null,
        nameError: null,
        onEditChange: (draft) =>
          setEditSession((current) =>
            current ? { ...current, draft } : current,
          ),
        onOpenSession: () => undefined,
        onRun: async () => undefined,
        owner: {
          ownerKind: "registered_space",
          ownerPath: "/repo",
          projectPath: "/repo",
          spaceId: "space:root",
          spacePath: "/repo",
        },
        peek,
        pending: false,
        readOnly: false,
        recovery: {},
        items,
        setEditSession,
      });
      const idle = { status: "idle" } as const;
      const presentation = createRoutinesPresentation({
        ownership: { collection: null, space: "Project" },
        actions: {
          createState: idle,
          getDeleteState: () => idle,
          getEditState: () => idle,
          getEnabledState: () => idle,
          getRunState: () => runState,
          onAdd: () => undefined,
          onDelete: () => undefined,
          onEdit: (item) =>
            setEditSession({
              draft: item.definition!,
              guard: { dirty: false },
              item,
            }),
          onEnabledChange: async () => undefined,
          onRun: async () => undefined,
        },
        executors,
        state: items ? { items, phase: "ready" } : { phase: "initial" },
      });
      useEffect(() => {
        Object.assign(controls, {
          peek,
          setEditSession,
          setItems,
          setRunState,
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
    return { controls, root, saved };
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

  test("a Routine opens with identity, ⋯ and Run now in the top bar, follows its item and keeps ⋯ after editing", async () => {
    const { controls, root, saved } = await setup();
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
    expect(doc.querySelector("[data-object-content-header]")?.textContent).toBe(
      "Daily summaryReview the current owner.",
    );
    // No footer, no owner line.
    expect(doc.querySelector(".border-t")).toBeNull();

    // An external edit and a new run state draw in place.
    const scroll = doc.querySelector("[data-collection-item-peek-scroll]");
    await run(() => controls.setItems!([renamed("Weekly summary")]));
    expect(identity()).toBe("Weekly summary");
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

    // The edit form opens in the same peek and keeps its draft through
    // external changes and removal.
    await run(() =>
      controls.setEditSession!({
        draft: renamed("Weekly summary").definition!,
        guard: { dirty: true },
        item: renamed("Weekly summary"),
      }),
    );
    expect(button("Save") === null).toBe(false);
    await run(() => controls.setItems!([renamed("Monthly summary")]));
    expect(button("Save") === null).toBe(false);
    await run(() => controls.setItems!([]));
    expect(button("Save") === null).toBe(false);
    await run(() => controls.setItems!([renamed("Monthly summary")]));

    // Cancel shows the current Routine with its ⋯ again.
    await run(() => button("Cancel")!.click());
    expect(button("Save")).toBeNull();
    expect(identity()).toBe("Monthly summary");
    expect(menu() === null).toBe(false);

    // Save shows the saved Routine with its ⋯ in the same peek.
    await run(() =>
      controls.setEditSession!({
        draft: {
          ...renamed("Yearly summary").definition!,
          action: {
            set: { status: "Done" },
            target: "trigger.entry",
            type: "update_properties",
          },
        },
        guard: { dirty: true },
        item: renamed("Monthly summary"),
      }),
    );
    await run(() => button("Save")!.click());
    expect(saved.map((item) => item.name)).toEqual(["Yearly summary"]);
    expect(button("Save")).toBeNull();
    expect(identity()).toBe("Yearly summary");
    expect(menu() === null).toBe(false);

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

  test("Edit of a closed Routine opens its form in the peek", async () => {
    const { controls, root } = await setup();
    await run(() =>
      controls.setEditSession!({
        draft: routine.definition!,
        guard: { dirty: false },
        item: routine,
      }),
    );
    expect(identity()).toBe("Daily summary");
    expect(button("Save") === null).toBe(false);
    await run(() => button("Cancel")!.click());
    expect(button("Save")).toBeNull();
    expect(menu() === null).toBe(false);
    await act(async () => root.unmount());
  }, 30000);
}
