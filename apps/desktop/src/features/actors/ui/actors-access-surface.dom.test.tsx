import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { createRegisteredSpaceOwner } from "@/features/scope-surfaces";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { ActorCatalogRow } from "../model/types";
import { ActorsSurface } from "./actors-surface";

const actor: ActorCatalogRow = {
  aliases: [],
  availableYears: [2026],
  canonicalEmail: "ada@example.test",
  commitCount: 4,
  contribution: "contributor",
  displayName: "Ada Lovelace",
  lastActivityDate: "2026-07-31",
  lastCommitAt: 20,
  sources: [],
};

test("Actors refreshes both catalogs from owner events without access probes", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  mockNativeIpc(
    (command) => {
      calls.push(command);
      if (command === "repository_access_get") {
        return {
          checkedAt: null,
          expiresAt: null,
          generation: 1,
          lastKnownStatus: null,
          reason: "expired",
          repositoryId: "access-repo-test",
          status: "unknown",
        };
      }
      if (command === "agent_actors_get") {
        return {
          adapterDescriptors: [],
          bindings: [],
          ownerFingerprints: { "/repo": "agent-catalog-fingerprint" },
          resolution: { actors: [], diagnostics: [] },
        };
      }
      if (command === "actors_get_catalog") return catalogSnapshot(1);
      if (command === "actors_refresh_catalog") return catalogSnapshot(2);
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);
  const owner = createRegisteredSpaceOwner({
    hasSchema: false,
    projectPath: "/project",
    spaceId: "root",
    spacePath: "/repo",
    status: "ready",
  });

  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorsSurface owner={owner} presentation="full" />
        </TooltipProvider>,
      );
      await nextTurn();
      await nextTurn();
    });

    expect(
      dom.window.document.querySelector("[data-repository-access-header]"),
    ).toBeNull();
    expect(calls.includes("repository_access_verify")).toBe(false);
    expect(
      dom.window.document.querySelector<HTMLButtonElement>(
        '[data-collection-create="add-actor"]',
      )?.disabled,
    ).toBe(false);

    expect(
      dom.window.document.querySelector("[data-collection-refresh]"),
    ).toBeNull();
    await act(async () => {
      await emitNativeEvent("actors:invalidated", {
        generation: 2,
        repositoryId: "sibling-repo",
      });
      await emitNativeEvent("agent-actors:invalidated", {
        ownerPath: "/sibling",
      });
      await waitForDebounce();
    });
    expect(calls.includes("actors_refresh_catalog")).toBe(false);
    expect(
      calls.filter((command) => command === "agent_actors_get").length,
    ).toBe(1);

    await act(async () => {
      await emitNativeEvent("actors:invalidated", {
        generation: 2,
        repositoryId: "actor-repo-test",
      });
      await emitNativeEvent("agent-actors:invalidated", {
        ownerPath: "/project",
      });
      await waitForDebounce();
    });
    expect(calls.includes("actors_refresh_catalog")).toBe(true);
    expect(
      calls.filter((command) => command === "agent_actors_get").length,
    ).toBe(2);
    expect(calls.includes("repository_access_verify")).toBe(false);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorsSurface readOnly owner={owner} presentation="full" />
        </TooltipProvider>,
      );
      await nextTurn();
    });
    expect(
      dom.window.document.querySelector<HTMLButtonElement>(
        '[data-collection-create="add-actor"]',
      )?.disabled,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function catalogSnapshot(generation: number) {
  return {
    diagnostics: [],
    generation,
    repositoryId: "actor-repo-test",
    rows: [actor],
    shallow: false,
  };
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForDebounce() {
  return new Promise((resolve) => setTimeout(resolve, 160));
}

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
