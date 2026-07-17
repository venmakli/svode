import { expect, test } from "bun:test";
import type { ComponentType } from "react";
import {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
} from "./owners";
import {
  resolveScopeSurfaceContributions,
  SCOPE_SURFACE_ORDER,
} from "./registry";
import type { ScopeSurfaceContribution, ScopeSurfaceId } from "./types";

const Icon = (() => null) as ComponentType<{ className?: string }>;

function contribution(
  id: ScopeSurfaceId,
  input: Partial<ScopeSurfaceContribution> = {},
): ScopeSurfaceContribution {
  return {
    id,
    order: SCOPE_SURFACE_ORDER[id],
    presentations: ["full", "compact"],
    appliesTo: () => true,
    label: id,
    icon: Icon,
    render: () => null,
    ...input,
  };
}

test("registry filters capability and presentation without changing canonical order", () => {
  const owner = createRegisteredSpaceOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready",
    hasSchema: true,
  });
  const contributions = [
    contribution("agent", { presentations: ["full"] }),
    contribution("collection", {
      appliesTo: (candidate) => candidate.capabilities.includes("collection"),
    }),
    contribution("readme"),
    contribution("routines"),
  ];

  expect(
    resolveScopeSurfaceContributions(contributions, owner, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines", "agent"]);
  expect(
    resolveScopeSurfaceContributions(contributions, owner, "compact").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines"]);
});

test("registry keeps root, child, and hybrid owner capabilities independent", () => {
  const contributions = [
    contribution("readme"),
    contribution("collection", {
      appliesTo: (owner) => owner.capabilities.includes("collection"),
    }),
    contribution("routines"),
    contribution("agent", {
      presentations: ["full"],
      appliesTo: (owner) => owner.capabilities.includes("space"),
    }),
  ];
  const root = createRegisteredSpaceOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready",
    hasSchema: false,
  });
  const child = createRegisteredSpaceOwner({
    spaceId: "child",
    projectPath: "/repo",
    spacePath: "/repo/child",
    status: "ready",
    hasSchema: false,
  });
  const hybrid = createRegisteredSpaceOwner({
    spaceId: "hybrid",
    projectPath: "/repo",
    spacePath: "/repo/hybrid",
    status: "ready",
    hasSchema: true,
  });
  const collection = createCollectionDirectoryOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath: "tasks",
    status: "ready",
    hasSchema: true,
  });

  expect(
    resolveScopeSurfaceContributions(contributions, root, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "routines", "agent"]);
  expect(
    resolveScopeSurfaceContributions(contributions, child, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "routines", "agent"]);
  expect(
    resolveScopeSurfaceContributions(contributions, hybrid, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines", "agent"]);
  expect(
    resolveScopeSurfaceContributions(contributions, collection, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines"]);
});

test("registry rejects duplicate stable ids", () => {
  const owner = createRegisteredSpaceOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready",
    hasSchema: false,
  });

  let error: unknown;
  try {
    resolveScopeSurfaceContributions(
      [contribution("readme"), contribution("readme")],
      owner,
      "full",
    );
  } catch (caught) {
    error = caught;
  }

  expect(error instanceof Error ? error.message : null).toBe(
    "Duplicate scope surface contribution: readme",
  );
});
