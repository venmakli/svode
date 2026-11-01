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
};
const inherited: AgentActorItem = {
  ...own,
  actorRef: "agent:01arz3ndektsv4rrffq69g5faw",
  id: "01arz3ndektsv4rrffq69g5faw",
  inherited: true,
  ownerLabel: "repo",
  ownerPath: "/repo",
};
const participant: AgentActorItem = {
  ...own,
  actorRef: "agent:01arz3ndektsv4rrffq69g5fax",
  binding: { kind: "participant" },
  id: "01arz3ndektsv4rrffq69g5fax",
  mode: null,
  name: "Mine",
};

test("Agent Actors uses the fixed schema and one shared edit/delete descriptor set", async () => {
  const calls: string[] = [];
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: {
      createState: { status: "idle" },
      getDeleteState: () => ({ status: "idle" }),
      getEditState: () => ({ status: "idle" }),
      onAdd: () => calls.push("add"),
      onDelete: (item) => calls.push(`delete:${item.ownerPath}`),
      onEdit: (item) => calls.push(`edit:${item.ownerPath}`),
    },
    agents,
    facts,
    inheritedVisible: true,
    items: [own, inherited],
  });

  expect(descriptor.id).toBe("agents");
  expect(descriptor.properties.map((property) => property.key)).toEqual([
    "title",
    "agent",
    "approval",
    "status",
    "space",
  ]);
  expect(
    descriptor.properties.map((property) => [
      property.common ?? null,
      property.label,
    ]),
  ).toEqual([
    ["title", "Name"],
    ["agent", "Agent"],
    [null, "Approval mode"],
    [null, "Readiness"],
    ["space", "Space"],
  ]);
  expect(
    descriptor.layout.kind === "list" && descriptor.layout.visibleProperties,
  ).toEqual(["agent", "status", "space"]);
  expect(descriptor.itemActions?.map((action) => action.id)).toEqual([
    "edit-agent",
    "delete-agent",
  ]);
  await descriptor.create?.intents[0]?.run();
  for (const action of descriptor.itemActions ?? [])
    await action.run(inherited);
  expect(calls).toEqual(["add", "edit:/repo", "delete:/repo"]);
});

test("Agent Actors show the agent with its model, the device mode in the agent's words and the readiness", () => {
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: false,
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

test("Agent Actors rows lead with the shared rounded agent avatar", () => {
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: {
      createState: { status: "idle" },
      getDeleteState: () => ({ status: "idle" }),
      getEditState: () => ({ status: "idle" }),
      onAdd: () => undefined,
      onDelete: () => undefined,
      onEdit: () => undefined,
    },
    agents,
    facts,
    inheritedVisible: false,
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
    state: { phase: "ready", items: [inherited, own] },
  });
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    agents,
    facts,
    inheritedVisible: true,
    items: [inherited, own],
  });
  const ordered = applyCollectionQuery({
    descriptor,
    query: EMPTY_COLLECTION_QUERY,
    items: [inherited, own],
  });
  const searched = applyCollectionQuery({
    descriptor,
    query: { filters: [], search: "repo", sort: [] },
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
    getEditState: () => state,
    onAdd: () => undefined,
    onDelete: () => undefined,
    onEdit: () => undefined,
  };
}
