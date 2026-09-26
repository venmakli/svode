import { expect, test } from "bun:test";

import {
  EMPTY_AGENT_ACTOR_OPTIONS,
  agentActorOptionCatalogDiagnostics,
  resolveAgentActorReference,
  type AgentActorOptionsState,
} from "./agent-actor-reference";

const reference = "agent:01arz3ndektsv4rrffq69g5fav";
const option = {
  description: null,
  label: "Documentation Agent",
  ownerLabel: "Project",
  value: reference,
} as const;
const loaded: AgentActorOptionsState = {
  ...EMPTY_AGENT_ACTOR_OPTIONS,
  options: [option],
};

test("catalog diagnostics expose own/root collisions and unreadable catalogs", () => {
  expect(
    agentActorOptionCatalogDiagnostics([
      {
        code: "ambiguous_actor_id",
        message: `${reference} is defined by multiple effective catalogs`,
        ownerPath: "/repo",
      },
      {
        code: "ambiguous_actor_id",
        message: `${reference} is defined by multiple effective catalogs`,
        ownerPath: "/repo/docs",
      },
    ]),
  ).toEqual({ ambiguous: [reference], incomplete: false });
  expect(
    agentActorOptionCatalogDiagnostics([
      { code: "catalog_unavailable", message: "bad json", ownerPath: "/repo" },
    ]),
  ).toEqual({ ambiguous: [], incomplete: true });
});

test("reference resolution distinguishes every presentation state", () => {
  expect(resolveAgentActorReference(loaded, reference)).toEqual({
    option,
    reference,
    status: "resolved",
  });
  expect(
    resolveAgentActorReference(
      { ...EMPTY_AGENT_ACTOR_OPTIONS, loading: true },
      reference,
    ).status,
  ).toBe("loading");
  expect(
    resolveAgentActorReference({ ...loaded, loading: true }, reference).status,
  ).toBe("resolved");
  expect(
    resolveAgentActorReference(EMPTY_AGENT_ACTOR_OPTIONS, reference).status,
  ).toBe("missing");
  expect(
    resolveAgentActorReference(
      { ...EMPTY_AGENT_ACTOR_OPTIONS, ambiguous: [reference] },
      reference,
    ).status,
  ).toBe("ambiguous");
  expect(
    resolveAgentActorReference(
      { ...EMPTY_AGENT_ACTOR_OPTIONS, error: "catalog failed" },
      reference,
    ).status,
  ).toBe("error");
  expect(
    resolveAgentActorReference(
      { ...EMPTY_AGENT_ACTOR_OPTIONS, incomplete: true },
      reference,
    ).status,
  ).toBe("error");
});

test("rename changes the resolved label without changing the reference", () => {
  const renamed = resolveAgentActorReference(
    { ...loaded, options: [{ ...option, label: "Docs Writer" }] },
    reference,
  );
  expect(renamed.status === "resolved" && renamed.option.label).toBe(
    "Docs Writer",
  );
  expect(renamed.reference).toBe(reference);
});
