import { expect, test } from "bun:test";
import {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
  resolveScopeSurfaceContributions,
} from "@/features/scope-surfaces";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";

test("app registry exposes canonical Stage 7 surfaces for each owner", () => {
  const contributions = createScopeSurfaceContributions();
  const hybridSpace = createRegisteredSpaceOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
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
    resolveScopeSurfaceContributions(contributions, hybridSpace, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["agent", "readme", "collection", "routines"]);
  expect(
    resolveScopeSurfaceContributions(contributions, collection, "compact").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines"]);
});
