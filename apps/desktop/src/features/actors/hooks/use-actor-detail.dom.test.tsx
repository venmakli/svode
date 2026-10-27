import { expect, test } from "bun:test";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type {
  CollectionDetailController,
  CollectionDetailRequest,
  CollectionDetailRowBinding,
} from "@/features/collection/app-shell";

import type { ActorCatalogRow, ActorCatalogSnapshot } from "../model/types";
import { useActorDetail } from "./use-actor-detail";

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
const selection = {
  instanceKey: "actors:space:root",
  presentationId: "humans",
  rowId: actor.canonicalEmail,
};

function snapshotOf(
  rows: readonly ActorCatalogRow[],
  generation = 1,
): ActorCatalogSnapshot {
  return {
    diagnostics: [],
    generation,
    repositoryId: "repo",
    rows,
    shallow: false,
  };
}

interface HarnessControls {
  detail?: CollectionDetailRowBinding<ActorCatalogRow>;
  setSnapshot?: (snapshot: ActorCatalogSnapshot | null) => void;
}

function Harness({
  controls,
  controller,
}: {
  controls: HarnessControls;
  controller: CollectionDetailController;
}) {
  const [snapshot, setSnapshot] = useState<ActorCatalogSnapshot | null>(
    snapshotOf([actor]),
  );
  const detail = useActorDetail({ controller, snapshot, spacePath: "/repo" });
  useEffect(() => {
    Object.assign(controls, { detail, setSnapshot });
  }, [controls, detail]);
  return null;
}

test("an open person follows the catalog: a changed row and generation show, a person gone closes", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  let active: CollectionDetailRequest | null = null;
  let opens = 0;
  const controller: CollectionDetailController = {
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
      root.render(<Harness controls={controls} controller={controller} />),
    );
    await run(() =>
      controls.detail!.activation(selection)!(actor, {
        rowId: actor.canonicalEmail,
      }),
    );
    expect(markup(shown()?.title).includes("Ada Lovelace")).toBe(true);

    // A `.mailmap` change renames the person in the open detail.
    await run(() =>
      controls.setSnapshot!(
        snapshotOf([{ ...actor, displayName: "Ada King" }], 2),
      ),
    );
    expect(markup(shown()?.title).includes("Ada King")).toBe(true);
    const content = shown()?.content as {
      props: { catalogGeneration: number };
    };
    expect(content.props.catalogGeneration).toBe(2);
    expect(opens).toBe(1);

    // Loading keeps it; the person leaving the catalog closes it.
    await run(() => controls.setSnapshot!(null));
    expect(markup(shown()?.title).includes("Ada King")).toBe(true);
    await run(() => controls.setSnapshot!(snapshotOf([], 3)));
    expect(shown()).toBe(null);

    // The duplicate found by a mutation opens and follows as well.
    await run(() => controls.setSnapshot!(snapshotOf([actor], 4)));
    await run(() => controls.detail!.open(actor, selection));
    await run(() =>
      controls.setSnapshot!(
        snapshotOf([{ ...actor, displayName: "Augusta Ada" }], 5),
      ),
    );
    expect(markup(shown()?.title).includes("Augusta Ada")).toBe(true);
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
