import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CollectionItemPeekController } from "@/features/collection/app-shell";

import type { ActorPeekTarget } from "../model/actor-peek";
import type { AgentActorItem } from "../model/agent-actor-types";
import type { ActorCatalogItem, ActorCatalogSnapshot } from "../model/types";

const person: ActorCatalogItem = {
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
const agent: AgentActorItem = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  binding: { agent: "codex", kind: "agent", settings: [] },
  description: "Writes documentation",
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: true,
  mode: null,
  name: "Documentation Agent",
  ownerLabel: "repo",
  ownerPath: "/repo",
  version: "v1",
};
const agentItemId = JSON.stringify([agent.ownerPath, agent.id]);

function snapshotOf(
  items: readonly ActorCatalogItem[],
  generation = 1,
): ActorCatalogSnapshot {
  return {
    diagnostics: [],
    generation,
    repositoryId: "repo",
    items,
    shallow: false,
  };
}

if (process.env.SVODE_ACTOR_PEEK_DOM !== "1") {
  test("actor peek DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ACTOR_PEEK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><button id=row>Row</button></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
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
  // A failed test leaves its root mounted: the next one unmounts it first.
  const roots: Root[] = [];

  /** A switch inside the screen, as the activity modes of a person are. */
  function InnerSwitch({ label }: { label: string }) {
    const [on, setOn] = useState(false);
    return (
      <button
        type="button"
        data-inner-switch={on ? "on" : "off"}
        onClick={() => setOn(true)}
      >
        {label}
      </button>
    );
  }
  mock.module("../ui/actor-detail", () => ({
    ActorDetail: ({
      actor,
      catalogGeneration,
    }: {
      actor: ActorCatalogItem;
      catalogGeneration: number;
    }) => (
      <div data-person-detail={catalogGeneration}>
        <InnerSwitch label={actor.displayName} />
      </div>
    ),
  }));

  interface Controls {
    peek?: CollectionItemPeekController<ActorPeekTarget>;
    rerender?: () => void;
    setAgents?: (items: readonly AgentActorItem[]) => void;
    setSnapshot?: (snapshot: ActorCatalogSnapshot | null) => void;
  }

  async function setup() {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { createAgentAdapterDictionary } =
      await import("@/features/agent-adapters");
    const { CollectionItemPeek, useCollectionItemPeek } =
      await import("@/features/collection/app-shell");
    const { actorPeekIdentity } = await import("../model/actor-peek");
    const { createActorsPresentation } =
      await import("../ui/actors-presentation");
    const { createAgentActorsPresentation } =
      await import("../ui/agent-actors-presentation");
    const { useActorPeek } = await import("./use-actor-peek");
    const { useAgentActorPeek } = await import("./use-agent-actor-peek");
    const agents = createAgentAdapterDictionary([
      { displayName: "Codex", id: "codex" },
    ]);
    const idle = { status: "idle" } as const;
    const controls: Controls = {};

    function Harness() {
      const [snapshot, setSnapshot] = useState<ActorCatalogSnapshot | null>(
        snapshotOf([person]),
      );
      const [agentItems, setAgents] = useState<readonly AgentActorItem[]>([
        agent,
      ]);
      const [, setVersion] = useState(0);
      const peek = useCollectionItemPeek<ActorPeekTarget>(actorPeekIdentity);
      const humanPeek = useActorPeek({ snapshot, spacePath: "/repo" });
      const agentPeek = useAgentActorPeek({
        editState: () => idle,
        focusTitleRequest: null,
        items: agentItems,
        write: async () => undefined,
      });
      const humans = createActorsPresentation({
        mutations: {
          createState: idle,
          getEditState: () => idle,
          getMergeState: () => idle,
          onAdd: () => undefined,
          onEdit: () => undefined,
          onMerge: () => undefined,
        },
        state: snapshot
          ? { items: snapshot.items, phase: "ready" }
          : { phase: "initial" },
      });
      const agentsPresentation = createAgentActorsPresentation({
        actions: {
          createState: idle,
          getDeleteState: () => idle,
          onAdd: () => undefined,
          onDelete: () => undefined,
        },
        agents,
        facts: () => ({
          bindable: true,
          model: null,
          mode: null,
          readiness: "ready",
        }),
        inheritedVisible: true,
        spaceName: () => null,
        state: { items: agentItems, phase: "ready" },
      });
      useEffect(() => {
        Object.assign(controls, {
          peek,
          rerender: () => setVersion((version) => version + 1),
          setAgents,
          setSnapshot,
        });
      }, [peek]);
      return (
        <CollectionItemPeek<ActorPeekTarget, ActorCatalogItem | AgentActorItem>
          peek={peek}
          find={(target) =>
            target.presentationId === "humans"
              ? humanPeek.find(target.itemId)
              : agentPeek.find(target.itemId)
          }
          render={(item, target) =>
            target.presentationId === "humans"
              ? humanPeek.render(item as ActorCatalogItem, humans)
              : agentPeek.render(item as AgentActorItem, agentsPresentation)
          }
        />
      );
    }

    const root = createRoot(doc.body.appendChild(doc.createElement("div")));
    roots.push(root);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Harness />
        </TooltipProvider>,
      );
    });
    return {
      controls,
      root,
    };
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
  const header = () =>
    doc.querySelector("[data-object-content-header]")?.textContent ?? null;
  const menu = () =>
    topBar()?.querySelector('[aria-label="Row actions"]') ?? null;
  const peekOpen = () => doc.querySelector("[data-collection-item-peek]");
  const titleInput = () =>
    doc.querySelector<HTMLInputElement>("[data-object-content-header-title]");
  const descriptionInput = () =>
    doc.querySelector<HTMLTextAreaElement>(
      "[data-object-content-header-description]",
    );
  const innerSwitch = () =>
    doc.querySelector("[data-inner-switch]")?.getAttribute("data-inner-switch");

  test("a person opens with identity and ⋯ in the top bar and follows the catalog", async () => {
    const { controls } = await setup();
    await run(() =>
      controls.peek!.open(
        { itemId: person.canonicalEmail, presentationId: "humans" },
        { returnFocus: () => doc.getElementById("row") },
      ),
    );
    expect(identity()).toBe("Ada Lovelace");
    expect(header()?.endsWith("Ada Lovelaceada@example.test")).toBe(true);
    expect(menu() === null).toBe(false);

    // A switch inside the screen and a `.mailmap` change keep the screen.
    await run(() =>
      doc.querySelector<HTMLButtonElement>("[data-inner-switch]")!.click(),
    );
    await run(() =>
      controls.setSnapshot!(
        snapshotOf([{ ...person, displayName: "Ada King" }], 2),
      ),
    );
    expect(identity()).toBe("Ada King");
    expect(innerSwitch()).toBe("on");
    expect(
      doc
        .querySelector("[data-person-detail]")
        ?.getAttribute("data-person-detail"),
    ).toBe("2");
    expect(menu() === null).toBe(false);

    // Loading keeps it; the person leaving the catalog closes it.
    await run(() => controls.setSnapshot!(null));
    expect(identity()).toBe("Ada King");
    await run(() => controls.setSnapshot!(snapshotOf([], 3)));
    await run(() => undefined);
    expect(peekOpen()).toBeNull();
    expect(doc.activeElement?.id).toBe("row");
  }, 30000);

  test("an Agent opens without an owner line or a body, with its name and description in place and ⋯ after a change", async () => {
    const { controls } = await setup();
    await run(() =>
      controls.peek!.open({ itemId: agentItemId, presentationId: "agents" }),
    );
    expect(identity()).toBe("Documentation Agent");
    expect(titleInput()?.value).toBe("Documentation Agent");
    expect(descriptionInput()?.value).toBe("Writes documentation");
    expect(doc.body.textContent?.includes("Owner")).toBe(false);
    expect(menu() === null).toBe(false);
    // The screen ends with the property panel.
    const column = doc.querySelector("[data-object-content-header]")
      ?.parentElement as HTMLElement;
    expect(
      Array.from(column.children).map((child) =>
        child.hasAttribute("data-object-content-header")
          ? "header"
          : child.hasAttribute("data-collection-property-panel")
            ? "panel"
            : child.tagName,
      ),
    ).toEqual(["header", "panel"]);

    // An external change draws in place.
    await run(() => controls.setAgents!([{ ...agent, name: "Docs Agent" }]));
    expect(identity()).toBe("Docs Agent");
    expect(titleInput()?.value).toBe("Docs Agent");
    expect(menu() === null).toBe(false);

    // The agent leaving the catalog closes its peek.
    await run(() => controls.setAgents!([]));
    expect(peekOpen()).toBeNull();
  }, 30000);

  test("moving from an Agent to a person passes no guard of the Agent", async () => {
    const { controls } = await setup();
    let asked = 0;
    dom.window.confirm = (() => {
      asked += 1;
      return Promise.resolve(true);
    }) as unknown as typeof window.confirm;
    await run(() =>
      controls.peek!.open({ itemId: agentItemId, presentationId: "agents" }),
    );
    await run(() =>
      controls.peek!.open({
        itemId: person.canonicalEmail,
        presentationId: "humans",
      }),
    );
    expect(asked).toBe(0);
    expect(identity()).toBe("Ada Lovelace");
  }, 30000);
}
