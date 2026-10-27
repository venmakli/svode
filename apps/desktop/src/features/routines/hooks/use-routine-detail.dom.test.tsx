import { expect, test } from "bun:test";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import type { CollectionActionState } from "@/features/collection";
import type {
  CollectionDetailController,
  CollectionDetailRequest,
  CollectionDetailRowBinding,
} from "@/features/collection/app-shell";

import type { RoutineRow } from "../model/types";
import { useRoutineDetail } from "./use-routine-detail";
import type { RoutineEditSession } from "./use-routine-mutations";

const executors: AgentActorOptionsState = {
  ambiguous: [],
  error: null,
  incomplete: false,
  loading: false,
  options: [],
};
const routine: RoutineRow = {
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
const selection = {
  instanceKey: "routines:space:root",
  presentationId: "all",
  rowId: routine.id,
};

function renamed(name: string): RoutineRow {
  return {
    ...routine,
    definition: { ...routine.definition!, name },
    fingerprint: `fingerprint:${name}`,
    name,
  };
}

interface HarnessControls {
  detail?: CollectionDetailRowBinding<RoutineRow>;
  setEditSession?: (session: RoutineEditSession | null) => void;
  setRows?: (rows: readonly RoutineRow[] | null) => void;
  setRunState?: (state: CollectionActionState) => void;
}

function Harness({
  controls,
  detailController,
}: {
  controls: HarnessControls;
  detailController: CollectionDetailController;
}) {
  const [rows, setRows] = useState<readonly RoutineRow[] | null>([routine]);
  const [runState, setRunState] = useState<CollectionActionState>({
    status: "idle",
  });
  const [editSession, setEditSession] = useState<RoutineEditSession | null>(
    null,
  );
  const detail = useRoutineDetail({
    applyUpdate: async () => null,
    detailController,
    editSession,
    executors,
    getRunState: () => runState,
    instanceKey: selection.instanceKey,
    mutationError: null,
    nameError: null,
    onEditChange: () => undefined,
    onOpenSession: () => undefined,
    onRun: async () => undefined,
    owner: {
      ownerKind: "registered_space",
      ownerPath: "/repo",
      projectPath: "/repo",
      spaceId: "space:root",
      spacePath: "/repo",
    },
    pending: false,
    readOnly: false,
    rows,
    setEditSession,
  });
  useEffect(() => {
    Object.assign(controls, {
      detail,
      setEditSession,
      setRows,
      setRunState,
    });
  }, [controls, detail]);
  return null;
}

test("an open read-only Routine follows its row, closes once it is gone and leaves its edit form alone", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  let active: CollectionDetailRequest | null = null;
  let opens = 0;
  const detailController: CollectionDetailController = {
    async close() {
      active = null;
      return true;
    },
    async open(request) {
      active = request;
      opens += 1;
      return true;
    },
    async update(shown, next) {
      if (active !== shown) return false;
      active = next;
      return true;
    },
  };
  const shown = () => active as CollectionDetailRequest | null;
  const markup = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
  const controls: HarnessControls = {};
  const root = createRoot(dom.window.document.getElementById("app")!);
  const run = async (action: () => unknown) => {
    await act(async () => {
      await action();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  try {
    await run(() =>
      root.render(
        <Harness controls={controls} detailController={detailController} />,
      ),
    );
    await run(() =>
      controls.detail!.activation(selection)!(routine, {
        actions: (row) => `Act on ${(row as RoutineRow).name}`,
        rowId: routine.id,
      }),
    );
    expect(opens).toBe(1);
    expect(markup(shown()?.title).includes("Daily summary")).toBe(true);

    // An external edit and a new run state show in the open Routine.
    await run(() => controls.setRows!([renamed("Weekly summary")]));
    expect(markup(shown()?.title).includes("Weekly summary")).toBe(true);
    expect(markup(shown()?.headerActions)).toBe("Act on Weekly summary");
    const beforeRun = shown();
    await run(() => controls.setRunState!({ status: "pending" }));
    expect(shown() === beforeRun).toBe(false);
    expect(opens).toBe(1);

    // Loading keeps the Routine as it is.
    await run(() => controls.setRows!(null));
    expect(markup(shown()?.title).includes("Weekly summary")).toBe(true);
    await run(() => controls.setRows!([renamed("Weekly summary")]));

    // The edit form keeps its draft through external changes and removal.
    await run(() =>
      controls.setEditSession!({
        draft: renamed("Weekly summary").definition!,
        guard: { dirty: true },
        row: renamed("Weekly summary"),
      }),
    );
    expect(shown()?.layout).toBe("form");
    const formTitle = markup(shown()?.title);
    await run(() => controls.setRows!([renamed("Monthly summary")]));
    expect(shown()?.layout).toBe("form");
    expect(markup(shown()?.title)).toBe(formTitle);
    await run(() => controls.setRows!([]));
    expect(shown()?.layout).toBe("form");
    await run(() => controls.setRows!([renamed("Monthly summary")]));

    // Cancel shows the current Routine with its row actions again.
    const footer = dom.window.document.createElement("div");
    dom.window.document.body.append(footer);
    const footerRoot = createRoot(footer);
    await run(() => footerRoot.render(<>{shown()?.footerActions}</>));
    await run(() =>
      footer.querySelector<HTMLButtonElement>('button[type="button"]')!.click(),
    );
    await run(() => footerRoot.unmount());
    expect(shown()?.layout).toBe(undefined);
    expect(markup(shown()?.title).includes("Monthly summary")).toBe(true);
    expect(markup(shown()?.headerActions)).toBe("Act on Monthly summary");

    // An external delete closes the read-only Routine.
    await run(() => controls.setRows!([]));
    expect(shown()).toBe(null);

    // Opened by an addressed request, it follows the catalog too.
    await run(() => controls.setRows!([routine]));
    await run(() => controls.detail!.open(routine, selection));
    expect(markup(shown()?.title).includes("Daily summary")).toBe(true);
    await run(() => controls.setRows!([renamed("Nightly summary")]));
    expect(markup(shown()?.title).includes("Nightly summary")).toBe(true);
    // A Routine that lost its id is a Routine that is gone.
    await run(() =>
      controls.setRows!([
        { ...routine, id: "invalid:.routines/daily-summary.md" },
      ]),
    );
    expect(shown()).toBe(null);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
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
