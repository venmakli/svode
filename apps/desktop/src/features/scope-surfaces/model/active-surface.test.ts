import { expect, test } from "bun:test";
import type { ScopeSurfaceContribution } from "./types";
import { resolveActiveScopeSurface } from "./active-surface";

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
