import { expect, test } from "bun:test";

import type {
  AgentActorCatalogDiagnostic,
  AgentActorCatalogSnapshot,
} from "./agent-actor-types";
import {
  isAgentActorCatalogReadComplete,
  isPersonCatalogReadComplete,
} from "./catalog-completeness";
import type { ActorCatalogSnapshot, ActorDiagnostic } from "./types";

function people(
  diagnostics: readonly ActorDiagnostic[],
  shallow = false,
): ActorCatalogSnapshot {
  return { diagnostics, generation: 1, items: [], repositoryId: "/repo", shallow };
}

function personDiagnostic(
  kind: string,
  blocking: boolean,
): ActorDiagnostic {
  return {
    blocking,
    kind: kind as ActorDiagnostic["kind"],
    line: null,
    message: kind,
  };
}

function agents(
  diagnostics: readonly AgentActorCatalogDiagnostic[],
): AgentActorCatalogSnapshot {
  return {
    agents: [],
    diagnostics,
    fingerprints: {},
    items: [],
    launchSpacePath: "/project/space",
  };
}

test("a read of people without diagnostics is complete", () => {
  expect(isPersonCatalogReadComplete(people([]))).toBe(true);
});

test("a custom source loses no person", () => {
  expect(
    isPersonCatalogReadComplete(
      people([personDiagnostic("custom_source", false)]),
    ),
  ).toBe(true);
});

test("a .mailmap the read could not use, a shallow clone or an unknown diagnostic may have lost people", () => {
  for (const snapshot of [
    people([personDiagnostic("unsafe_file", true)]),
    people([personDiagnostic("invalid_line", true)]),
    people([personDiagnostic("invalid_line", false)]),
    people([personDiagnostic("future_problem", false)]),
    people([personDiagnostic("custom_source", false)], true),
    people([], true),
  ]) {
    expect(isPersonCatalogReadComplete(snapshot)).toBe(false);
  }
});

test("a read of Agent Actors without diagnostics is complete", () => {
  expect(isAgentActorCatalogReadComplete(agents([]))).toBe(true);
});

test("an unreadable own or root catalog, an ambiguous id or an unknown diagnostic may have lost Agents", () => {
  for (const diagnostic of [
    {
      code: "catalog_unavailable",
      message: "newer schema",
      ownerPath: "/project/space",
      reason: "newer_format",
    },
    {
      code: "catalog_unavailable",
      message: "newer schema",
      ownerPath: "/project",
      reason: "newer_format",
    },
    {
      code: "ambiguous_actor_id",
      message: "agent:01arz3ndektsv4rrffq69g5fav is defined by multiple effective catalogs",
      ownerPath: "/project",
    },
    { code: "future_problem", message: "", ownerPath: "/project" },
  ] satisfies AgentActorCatalogDiagnostic[]) {
    expect(isAgentActorCatalogReadComplete(agents([diagnostic]))).toBe(false);
  }
});
