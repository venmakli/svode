import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import type { CollectionInstance } from "@/features/collection";
import { createTestDom } from "@/shared/testing/dom";

import type { AgentActorFacts } from "../model/agent-actor-facts";
import type { AgentActorItem } from "../model/agent-actor-types";

// The common property "Agent" of the Agents collection in the DOM: the cell,
// the filter and the sort. Sessions run the same scenario over the same
// agents and expect the same result.
if (process.env.SVODE_AGENT_ACTORS_COMMON_PROPERTIES_DOM !== "1") {
  test("Agents common properties DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_ACTORS_COMMON_PROPERTIES_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  function agentActor(id: string, name: string, agent: string): AgentActorItem {
    return {
      actorRef: `agent:${id}`,
      binding: { agent, kind: "agent", settings: [] },
      description: null,
      id,
      inherited: false,
      mode: null,
      name,
      ownerLabel: "docs",
      ownerPath: "/repo/docs",
    };
  }
  const agentActors: AgentActorItem[] = [
    agentActor("01arz3ndektsv4rrffq69g5faa", "Alpha", "claude-code"),
    agentActor("01arz3ndektsv4rrffq69g5fab", "Beta", "codex"),
    agentActor("01arz3ndektsv4rrffq69g5fac", "Gamma", "codex"),
  ];
  const participant: AgentActorItem = {
    ...agentActor("01arz3ndektsv4rrffq69g5fad", "Mine", "codex"),
    binding: { kind: "participant" },
  };
  const facts = (item: AgentActorItem): AgentActorFacts => ({
    model: item.name === "Beta" ? "GPT-5.4" : null,
    mode: null,
    readiness: "ready",
  });

  async function renderAgents(
    items: readonly AgentActorItem[],
    {
      inheritedVisible = false,
      spaceNames = {},
      writes = [],
    }: {
      inheritedVisible?: boolean;
      spaceNames?: Record<string, string>;
      writes?: string[];
    } = {},
  ) {
    const dom = await createTestDom();
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { createAgentAdapterDictionary } =
      await import("@/features/agent-adapters");
    const { CollectionHost, useCollectionState } =
      await import("@/features/collection");
    const { agentActorItemId, createAgentActorsPresentation } =
      await import("./agent-actors-presentation");
    const agents = createAgentAdapterDictionary([
      { id: "codex", displayName: "Codex" },
      { id: "claude-code", displayName: "Claude Code" },
    ]);
    const idle = { status: "idle" } as const;
    // Like the surface, the presentation is built on every render from the
    // Space names the Space store holds at that moment.
    function Host({ names }: { names: Record<string, string> }) {
      const instance: CollectionInstance = {
        defaultPresentationId: "agents",
        instanceKey: "agents:common-properties",
        presentations: [
          createAgentActorsPresentation({
            actions: {
              createState: idle,
              getDeleteState: () => idle,
              getEditState: () => idle,
              onAdd: () => writes.push("add"),
              onDelete: (item) => writes.push(`delete:${item.id}`),
              onEdit: (item) => writes.push(`edit:${item.id}`),
            },
            agents,
            facts,
            inheritedVisible,
            spaceName: (path) => names[path] ?? null,
            onActivate: () => undefined,
            state: { phase: "ready", items },
          }),
        ],
        stateScope: "lifecycle",
      };
      const state = useCollectionState(instance);
      return state.phase === "ready" ? (
        <TooltipProvider>
          <CollectionHost instance={instance} state={state} />
        </TooltipProvider>
      ) : null;
    }
    await dom.render(<Host names={spaceNames} />);
    const rename = (names: Record<string, string>) =>
      dom.render(<Host names={names} />);
    const names: Record<string, string> = Object.fromEntries(
      items.map((item) => [agentActorItemId(item), item.name]),
    );
    const cell = (name: string) => {
      const item = items.find((candidate) => candidate.name === name)!;
      return dom.document.querySelector(
        `[data-collection-row='${agentActorItemId(item)}'] [data-agent-property]`,
      );
    };
    const rowText = (name: string) => {
      const item = items.find((candidate) => candidate.name === name)!;
      return dom.document.querySelector(
        `[data-collection-row='${agentActorItemId(item)}']`,
      )?.textContent;
    };
    return { cell, dom, names, rename, rowText };
  }

  /**
   * Filters and sorts by a property through the query editor of the
   * Collection, as a user does: the options its filter offers, the rows the
   * filter leaves and the rows the sort orders.
   */
  async function queryByProperty(
    document: Document,
    names: Record<string, string>,
    label: string,
    choose: (pane: HTMLElement) => Promise<void>,
  ) {
    const { buttonByText, clickElement } =
      await import("@/shared/testing/dom-query");
    const pane = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    const rows = () =>
      [...document.querySelectorAll("[data-collection-row]")].map(
        (row) => names[row.getAttribute("data-collection-row")!],
      );
    await clickElement(buttonByText(document, "Filters"));
    await clickElement(buttonByText(pane(), "Add filter"));
    await clickElement(buttonByText(pane(), label));
    const filterOptions = [
      ...pane().querySelectorAll("label [data-slot='badge']"),
    ].map((badge) => badge.textContent);
    await choose(pane());
    await clickElement(buttonByText(pane(), "Apply filter"));
    const filtered = rows();
    await clickElement(buttonByText(pane(), label));
    await clickElement(buttonByText(pane(), "Clear filter"));
    await clickElement(buttonByText(document, "Sort"));
    await clickElement(buttonByText(pane(), "Add sort"));
    await clickElement(buttonByText(pane(), label));
    await clickElement(buttonByText(pane(), "Apply sort"));
    return { filterOptions, filtered, sorted: rows() };
  }

  test("Agent: the cell, the filter and the sort follow the agent dictionary", async () => {
    const { cell, dom, names } = await renderAgents(agentActors);
    const { clickElement } = await import("@/shared/testing/dom-query");
    try {
      expect(
        ["Alpha", "Beta", "Gamma"].map((name) => [
          cell(name)?.getAttribute("data-agent-property"),
          cell(name)?.textContent,
          Boolean(cell(name)?.querySelector("[aria-hidden]")),
        ]),
      ).toEqual([
        ["claude-code", "Claude Code", true],
        // The model of the binding is said next to the agent.
        ["codex", "CodexGPT-5.4", true],
        ["codex", "Codex", true],
      ]);
      expect(
        await queryByProperty(dom.document, names, "Agent", (pane) =>
          clickElement(
            [...pane.querySelectorAll("label")]
              .find((option) => option.textContent === "Codex")!
              .querySelector<HTMLElement>('[role="checkbox"]')!,
          ),
        ),
      ).toEqual({
        filterOptions: ["Codex", "Claude Code"],
        filtered: ["Beta", "Gamma"],
        sorted: ["Beta", "Gamma", "Alpha"],
      });
    } finally {
      await dom.dispose();
    }
  });

  test("the participant's agent is a value and an option of Agent", async () => {
    const { cell, dom, names } = await renderAgents([
      ...agentActors,
      participant,
    ]);
    const { clickElement } = await import("@/shared/testing/dom-query");
    try {
      expect([
        cell("Mine")?.getAttribute("data-agent-property"),
        cell("Mine")?.textContent,
      ]).toEqual(["participant", "Participant's agent"]);
      expect(
        await queryByProperty(dom.document, names, "Agent", (pane) =>
          clickElement(
            [...pane.querySelectorAll("label")]
              .find((option) => option.textContent === "Participant's agent")!
              .querySelector<HTMLElement>('[role="checkbox"]')!,
          ),
        ),
      ).toEqual({
        filterOptions: ["Codex", "Claude Code", "Participant's agent"],
        filtered: ["Mine"],
        sorted: ["Beta", "Gamma", "Alpha", "Mine"],
      });
    } finally {
      await dom.dispose();
    }
  });

  const spaceNames = { "/repo": "Acme", "/repo/docs": "Documentation" };
  const inherited: AgentActorItem = {
    ...agentActor("01arz3ndektsv4rrffq69g5fae", "Delta", "codex"),
    description: "Reviews changes",
    inherited: true,
    ownerLabel: "repo",
    ownerPath: "/repo",
  };

  test("Space names the owner Space, its own or the project root, and follows a rename without a write", async () => {
    const writes: string[] = [];
    const { dom, rename, rowText } = await renderAgents(
      [agentActors[0], inherited],
      { inheritedVisible: true, spaceNames, writes },
    );
    try {
      // The column is shown where own and inherited Agents mix; the
      // description is only the Agent's own.
      const has = (name: string, text: string) =>
        rowText(name)?.includes(text) ?? false;
      expect([
        has("Alpha", "Documentation"),
        has("Delta", "Acme"),
        has("Delta", "Reviews changes"),
      ]).toEqual([true, true, true]);
      expect(
        ["Alpha", "Delta"].flatMap((name) =>
          ["docs", "repo", "Inherited"].filter((text) => has(name, text)),
        ),
      ).toEqual([]);
      await rename({ "/repo": "Acme Inc", "/repo/docs": "Guides" });
      expect([has("Alpha", "Guides"), has("Delta", "Acme Inc")]).toEqual([
        true,
        true,
      ]);
      expect(writes).toEqual([]);
    } finally {
      await dom.dispose();
    }
  });

  test("Space is hidden in a set without inherited Agents and still filters and sorts", async () => {
    const { dom, names, rowText } = await renderAgents(agentActors, {
      spaceNames,
    });
    const { clickElement } = await import("@/shared/testing/dom-query");
    try {
      expect(rowText("Alpha")?.includes("Documentation")).toBe(false);
      expect(
        await queryByProperty(dom.document, names, "Space", (pane) =>
          clickElement(
            [...pane.querySelectorAll("label")]
              .find((option) => option.textContent === "Documentation")!
              .querySelector<HTMLElement>('[role="checkbox"]')!,
          ),
        ),
      ).toEqual({
        filterOptions: ["Documentation"],
        filtered: ["Alpha", "Beta", "Gamma"],
        sorted: ["Alpha", "Beta", "Gamma"],
      });
    } finally {
      await dom.dispose();
    }
  });
}
