import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyCollectionQuery,
  EMPTY_COLLECTION_QUERY,
  CollectionPresentationShell,
} from "@/features/collection";

import { createAgentAdapterDictionary } from "@/features/agent-adapters";

import type { AgentActorFacts } from "../model/agent-actor-facts";
import type { AgentActorItem } from "../model/agent-actor-types";
import {
  createAgentActorsPresentation,
  createAgentActorsPresentationDescriptor,
} from "./agent-actors-presentation";

const agents = createAgentAdapterDictionary([
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
]);
const own: AgentActorItem = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  binding: {
    agent: "codex",
    kind: "agent",
    settings: [{ setting: "model", value: "gpt-5.4" }],
  },
  description: "Writes documentation",
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: false,
  mode: { agent: "codex", setting: "mode", value: "agent" },
  name: "Documentation Agent",
  ownerLabel: "docs",
  ownerPath: "/repo/docs",
  version: "v1",
};
const inherited: AgentActorItem = {
  ...own,
  actorRef: "agent:01arz3ndektsv4rrffq69g5faw",
  id: "01arz3ndektsv4rrffq69g5faw",
  inherited: true,
  ownerLabel: "repo",
  ownerPath: "/repo",
};
const spaceNames: Record<string, string> = {
  "/repo": "Acme",
  "/repo/docs": "Documentation",
};
const spaceName = (path: string) => spaceNames[path] ?? null;
const participant: AgentActorItem = {
  ...own,
  actorRef: "agent:01arz3ndektsv4rrffq69g5fax",
  binding: { kind: "participant" },
  id: "01arz3ndektsv4rrffq69g5fax",
  mode: null,
  name: "Mine",
};

test("Agent Actors uses the fixed schema and one shared delete descriptor", async () => {
  const calls: string[] = [];
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: {
      createState: { status: "idle" },
      getDeleteState: () => ({ status: "idle" }),
      onAdd: () => calls.push("add"),
      onDelete: (item) => calls.push(`delete:${item.ownerPath}`),
    },
    agents,
    facts,
    inheritedVisible: true,
    spaceName,
    items: [own, inherited],
  });

  expect(descriptor.id).toBe("agents");
  expect(descriptor.properties.map((property) => property.key)).toEqual([
    "title",
    "space",
    "agent",
    "approval",
    "status",
  ]);
  expect(
    descriptor.properties.map((property) => [
      property.common ?? null,
      property.label,
    ]),
  ).toEqual([
    ["title", "Name"],
    ["space", "Space"],
    ["agent", "Agent"],
    [null, "Approval mode"],
    [null, "Readiness"],
  ]);
  expect(
    descriptor.layout.kind === "list" && descriptor.layout.visibleProperties,
  ).toEqual(["agent", "status", "space"]);
  expect(descriptor.itemActions?.map((action) => action.id)).toEqual([
    "delete-agent",
  ]);
  await descriptor.create?.intents[0]?.run();
  for (const action of descriptor.itemActions ?? [])
    await action.run(inherited);
  expect(calls).toEqual(["add", "delete:/repo"]);
});

test("Agent Actors show the agent with its model, the device mode in the agent's words and the readiness", () => {
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: false,
    spaceName,
    items: [own, participant],
  });
  const value = (key: string, item: AgentActorItem) =>
    descriptor.properties
      .find((property) => property.key === key)
      ?.getValue(item);
  // The model is said next to the agent; filter and sort go by the agent.
  expect(value("agent", own)).toBe("Codex");
  expect(value("approval", own)).toBe("Auto review");
  expect(value("status", own)).toBe("Ready");
  expect(value("agent", participant)).toBe("Participant's agent");
  expect(value("approval", participant)).toBeNull();
  expect(value("status", participant)).toBe("No default agent");
});

test("Space of an Agent is the name of its owner Space: its own or the project root it is inherited from", () => {
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: true,
    spaceName,
    items: [own, inherited],
  });
  const space = descriptor.properties.find(
    (property) => property.key === "space",
  )!;
  expect(space.getValue(own)).toBe("Documentation");
  expect(space.getValue(inherited)).toBe("Acme");
  expect(
    space.semantics.kind === "standard" &&
      space.semantics.standard.options?.map((option) => option.name),
  ).toEqual(["Documentation", "Acme"]);
  expect(space.capabilities?.edit).toBe(undefined);
});

test("the Space column is shown only in a set with inherited Agents", () => {
  const visible = (inheritedVisible: boolean) => {
    const descriptor = createAgentActorsPresentationDescriptor({
      actions: disabledActions(),
      agents,
      facts,
      inheritedVisible,
      spaceName,
      items: inheritedVisible ? [own, inherited] : [own],
    });
    return descriptor.layout.kind === "list"
      ? descriptor.layout.visibleProperties
      : [];
  };
  expect(visible(true).includes("space")).toBe(true);
  expect(visible(false).includes("space")).toBe(false);
});

test("an Agent is described only by its own description", () => {
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: true,
    spaceName,
    items: [own, inherited],
  });
  const describe = (item: AgentActorItem) =>
    descriptor.layout.kind === "list"
      ? descriptor.layout.getDescription?.(item)
      : undefined;
  expect(describe(inherited)).toBe("Writes documentation");
  expect(describe({ ...inherited, description: null })).toBeNull();
});

test("Agent Actors rows lead with the shared rounded agent avatar", () => {
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: {
      createState: { status: "idle" },
      getDeleteState: () => ({ status: "idle" }),
      onAdd: () => undefined,
      onDelete: () => undefined,
    },
    agents,
    facts,
    inheritedVisible: false,
    spaceName,
    items: [own],
  });
  const leading =
    descriptor.layout.kind === "list"
      ? renderToStaticMarkup(<>{descriptor.layout.renderLeading?.(own)}</>)
      : "";
  expect(String(leading).includes('data-agent-avatar="neutral"')).toBe(true);
  expect(String(leading).includes("rounded-lg")).toBe(true);
});

test("Agent Actors rows never describe an agent by its raw reference", () => {
  const undescribed = { ...own, description: null };
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: false,
    spaceName,
    items: [undescribed],
  });
  const description =
    descriptor.layout.kind === "list"
      ? renderToStaticMarkup(
          <>{descriptor.layout.getDescription?.(undescribed)}</>,
        )
      : "";
  expect(description.includes(own.actorRef)).toBe(false);
  expect(description.includes(own.id)).toBe(false);
});

test("Agent Actors default order and search preserve owner provenance", () => {
  const presentation = createAgentActorsPresentation({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: true,
    spaceName,
    state: { phase: "ready", items: [inherited, own] },
  });
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: true,
    spaceName,
    items: [inherited, own],
  });
  const ordered = applyCollectionQuery({
    descriptor,
    query: EMPTY_COLLECTION_QUERY,
    items: [inherited, own],
  });
  const searched = applyCollectionQuery({
    descriptor,
    query: { filters: [], search: "acme", sort: [] },
    items: [own, inherited],
  });
  expect(ordered.items.map((item) => item.ownerPath)).toEqual([
    "/repo/docs",
    "/repo",
  ]);
  expect(searched.items.map((item) => item.ownerPath)).toEqual(["/repo"]);

  const markup = renderToStaticMarkup(
    <CollectionPresentationShell
      instanceKey="actors:space:docs"
      presentation={presentation}
      query={EMPTY_COLLECTION_QUERY}
      onQueryChange={() => undefined}
    />,
  );
  expect(markup.includes("data-collection-row")).toBe(true);
  expect(markup.includes("data-agent-adapter")).toBe(false);
});

/** What a device shows of the items above. */
function facts(item: AgentActorItem): AgentActorFacts {
  return item.binding.kind === "participant"
    ? {
        model: null,
        mode: null,
        readiness: "default_agent_missing",
      }
    : {
        model: "GPT-5.4",
        mode: { kind: "value", name: "Auto review" },
        readiness: "ready",
      };
}

function disabledActions() {
  const state = { reason: "disabled", status: "disabled" } as const;
  return {
    createState: state,
    getDeleteState: () => state,
    onAdd: () => undefined,
    onDelete: () => undefined,
  };
}
