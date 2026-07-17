import { expect, test } from "bun:test";
import { useScopeSurfaceStore } from "./surface-store";

test("surface selection is session-only and keyed by stable owner identity", () => {
  useScopeSurfaceStore.setState({ surfaceByOwnerKey: {} });

  useScopeSurfaceStore.getState().setSurface("space:root", "readme");
  useScopeSurfaceStore
    .getState()
    .setSurface("collection:root:tasks", "collection");

  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "space:root": "readme",
    "collection:root:tasks": "collection",
  });

  useScopeSurfaceStore.getState().clearSurface("space:root");
  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "collection:root:tasks": "collection",
  });
});
