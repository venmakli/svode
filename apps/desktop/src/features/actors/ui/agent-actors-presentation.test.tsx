import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyCollectionCoreQuery,
  EMPTY_COLLECTION_CORE_QUERY,
  CollectionCorePresentationShell,
} from "@/features/collection/core";

import type { AgentActorRow } from "../model/agent-actor-types";
import {
  createAgentActorsPresentation,
  createAgentActorsPresentationDescriptor,
} from "./agent-actors-presentation";

const own: AgentActorRow = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  adapters: [{ adapter: "codex", effort: "medium", model: "gpt-5.4" }],
  approvalMode: "auto",
  description: "Writes documentation",
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: false,
  name: "Documentation Agent",
  ownerLabel: "docs",
  ownerPath: "/repo/docs",
  runtimeStatus: "ready",
};
const inherited: AgentActorRow = {
  ...own,
  actorRef: "agent:01arz3ndektsv4rrffq69g5faw",
  id: "01arz3ndektsv4rrffq69g5faw",
  inherited: true,
  ownerLabel: "repo",
  ownerPath: "/repo",
  runtimeStatus: "unchecked",
};

test("Agent Actors uses the fixed schema and one shared edit/delete descriptor set", async () => {
  const calls: string[] = [];
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: {
      createState: { status: "idle" },
      getDeleteState: () => ({ status: "idle" }),
      getEditState: () => ({ status: "idle" }),
      onAdd: () => calls.push("add"),
      onDelete: (row) => calls.push(`delete:${row.ownerPath}`),
      onEdit: (row) => calls.push(`edit:${row.ownerPath}`),
    },
    inheritedVisible: true,
    rows: [own, inherited],
  });

  expect(descriptor.id).toBe("agents");
  expect(descriptor.properties.map((property) => property.key)).toEqual([
    "clients",
    "primary",
    "approval",
    "status",
    "space",
  ]);
  expect(descriptor.rowActions?.map((action) => action.id)).toEqual([
    "edit-agent",
    "delete-agent",
  ]);
  await descriptor.create?.run();
  for (const action of descriptor.rowActions ?? []) await action.run(inherited);
  expect(calls).toEqual(["add", "edit:/repo", "delete:/repo"]);
});

test("Agent Actors default order and search preserve owner provenance", () => {
  const presentation = createAgentActorsPresentation({
    actions: disabledActions(),
    inheritedVisible: true,
    state: { phase: "ready", rows: [inherited, own] },
  });
  const descriptor = createAgentActorsPresentationDescriptor({
    actions: disabledActions(),
    inheritedVisible: true,
    rows: [inherited, own],
  });
  const ordered = applyCollectionCoreQuery({
    descriptor,
    query: EMPTY_COLLECTION_CORE_QUERY,
    rows: [inherited, own],
  });
  const searched = applyCollectionCoreQuery({
    descriptor,
    query: { filters: [], search: "repo", sort: [] },
    rows: [own, inherited],
  });
  expect(ordered.rows.map((row) => row.ownerPath)).toEqual([
    "/repo/docs",
    "/repo",
  ]);
  expect(searched.rows.map((row) => row.ownerPath)).toEqual(["/repo"]);

  const markup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="actors:space:docs"
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={() => undefined}
    />,
  );
  expect(markup.includes("data-collection-core-row")).toBe(true);
  expect(markup.includes("data-agent-adapter")).toBe(false);
});

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
