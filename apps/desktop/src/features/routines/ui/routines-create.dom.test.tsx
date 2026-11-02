import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineItem,
  RoutineMutationResult,
} from "../model/types";

// Creating a Routine from the Routines: its file at once under the first
// free default name, opened in the peek with its name focused.
if (process.env.SVODE_ROUTINES_CREATE_DOM !== "1") {
  test("routine creation in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINES_CREATE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
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
    HTMLButtonElement: dom.window.HTMLButtonElement,
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
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const doc = dom.window.document;

  const owner = {
    identityKind: "registered-space" as const,
    ownerKey: "space:root",
    ownerPath: "/repo",
    projectPath: "/repo",
    spaceId: "root",
    spacePath: "/repo",
  };
  const item = (name: string, id: string): RoutineItem => ({
    definition: {
      action: { executor: "", type: "run_agent" },
      body: "",
      description: "",
      enabled: null,
      name,
      trigger: { type: "manual" },
    },
    definitionPath: `.routines/${id}.md`,
    description: "",
    diagnostics: [],
    filename: `${id}.md`,
    fingerprint: `fingerprint:${id}`,
    id,
    lastRun: null,
    lastRunAt: null,
    lastRunOrigin: null,
    name,
    nextRunAt: null,
    routineId: id,
    valid: true,
  });
  const snapshotOf = (items: RoutineItem[]): RoutineCatalogSnapshot => ({
    catalogFingerprint: items.map((candidate) => candidate.id).join(","),
    diagnostics: [],
    items,
    ownerPath: "/repo",
    refreshedAt: "2026-11-02T00:00:00.000Z",
    resolvedOwnerKind: "project",
    spaceId: "root",
  });

  const existing = item("New routine", "01existing");
  const created: RoutineDefinition[] = [];
  // Another create took "New routine 2" since the catalog was read.
  const takenMeanwhile = new Set(["New routine 2"]);

  const realApi = await import("../api/routines-api");
  mock.module("../api/routines-api", () => ({
    ...realApi,
    createRoutine: async (
      _owner: unknown,
      definition: RoutineDefinition,
    ): Promise<RoutineMutationResult> => {
      created.push(definition);
      if (takenMeanwhile.has(definition.name)) {
        return {
          conflict: {
            conflicts: [
              {
                filename: "new-routine-2.md",
                name: definition.name,
                path: ".routines/new-routine-2.md",
                routineId: "01other",
              },
            ],
            ownerPath: ".",
            resolvedOwnerKind: "project",
            spaceId: "root",
          },
          status: "name_conflict",
        };
      }
      const next = item(definition.name, "01created");
      return {
        changedPaths: [next.definitionPath],
        routineId: next.id,
        snapshot: snapshotOf([existing, next]),
        status: "applied",
        warnings: [],
      };
    },
    listenRoutineCatalogInvalidated: async () => () => undefined,
    loadRoutineAutomaticConsent: async () => ({
      enabled: false,
      ownerKind: "project",
      storageResetPending: false,
    }),
    loadRoutineCatalog: async () => snapshotOf([existing]),
    refreshRoutineCatalog: async () => snapshotOf([existing]),
  }));
  const realReference = await import("@/features/actors/agent-reference");
  mock.module("@/features/actors/agent-reference", () => ({
    ...realReference,
    loadAgentActorOptions: async () => ({
      ambiguous: [],
      incomplete: false,
      options: [],
    }),
  }));
  const realActors = await import("@/features/actors");
  mock.module("@/features/actors", () => ({
    ...realActors,
    listenAgentActorCatalogInvalidated: async () => () => undefined,
  }));
  mock.module("sonner", () => ({
    toast: { error() {}, success() {}, warning() {} },
  }));
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc(() => [], { shouldMockEvents: true });

  const { setLocale } = await import("@/paraglide/runtime");
  await setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { RoutinesSurface } = await import("./routines-surface");
  const { createRoot } = await import("react-dom/client");

  async function settle(ms = 30) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  test("Add creates the Routine at once under the first free default name and opens it with its name focused", async () => {
    const root = createRoot(doc.getElementById("app")!);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <RoutinesSurface
            owner={owner as never}
            presentation={"page" as never}
            readOnly={false}
            onOpenSession={() => undefined}
          />
        </TooltipProvider>,
      );
    });
    await settle();
    const add = [...doc.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Add",
    );
    expect(add === undefined).toBe(false);
    await act(async () => {
      add!.click();
    });
    await settle(80);

    expect(created.map((definition) => definition.name)).toEqual([
      "New routine 2",
      "New routine 3",
    ]);
    expect(created[1]).toEqual({
      action: { executor: "", type: "run_agent" },
      body: "",
      description: "",
      enabled: null,
      name: "New routine 3",
      trigger: { type: "manual" },
    });
    expect(doc.querySelector("[data-collection-item-peek]") === null).toBe(
      false,
    );
    const focused = doc.activeElement as HTMLTextAreaElement | null;
    expect(focused?.hasAttribute("data-object-content-header-title")).toBe(
      true,
    );
    expect(focused?.value).toBe("New routine 3");
    expect(focused?.selectionStart).toBe(0);
    expect(focused?.selectionEnd).toBe("New routine 3".length);
    // No wizard and no form: the properties are edited on the screen.
    expect(doc.querySelector('[role="dialog"] form')).toBeNull();
    expect(
      doc.querySelector('[data-collection-panel-property="executor"]') === null,
    ).toBe(false);
    await act(async () => root.unmount());
  }, 30_000);
}
