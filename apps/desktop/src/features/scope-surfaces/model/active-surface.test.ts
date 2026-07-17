import { expect, test } from "bun:test";
import type { ScopeSurfaceContribution } from "./types";
import {
  resolveActiveScopeSurface,
  resolveDefaultScopeSurface,
} from "./active-surface";
import {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
} from "./owners";

const surfaces = [
  { id: "readme" },
  { id: "collection" },
] as ScopeSurfaceContribution[];

test("uses the requested available scope surface", () => {
  expect(resolveActiveScopeSurface(surfaces, "collection")?.id).toBe(
    "collection",
  );
});

test("falls back to the first available scope surface", () => {
  expect(resolveActiveScopeSurface(surfaces, "agent")?.id).toBe("readme");
  expect(resolveActiveScopeSurface([], "readme")).toBeNull();
});

test("prefers a capability-safe default over registry order", () => {
  expect(resolveActiveScopeSurface(surfaces, "agent", "collection")?.id).toBe(
    "collection",
  );
});

test("uses readme for a registered space and collection for a collection owner", () => {
  expect(
    resolveDefaultScopeSurface(
      createRegisteredSpaceOwner({
        spaceId: "root",
        projectPath: "/repo",
        spacePath: "/repo",
        status: "ready",
        hasSchema: true,
      }),
    ),
  ).toBe("readme");
  expect(
    resolveDefaultScopeSurface(
      createCollectionDirectoryOwner({
        spaceId: "root",
        projectPath: "/repo",
        spacePath: "/repo",
        ownerPath: "tasks",
        status: "ready",
        hasSchema: true,
      }),
    ),
  ).toBe("collection");
});
