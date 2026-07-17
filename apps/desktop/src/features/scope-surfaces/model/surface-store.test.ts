import { expect, test } from "bun:test";
import { useScopeSurfaceStore } from "./surface-store";

test("surface selection is session-only and keyed by stable owner identity", () => {
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {},
    openRequestKeyByOwnerKey: {},
  });

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

test("keeps each owner selection until an explicit open intent replaces it", () => {
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: { "collection:root:tasks": "routines" },
    openRequestKeyByOwnerKey: {},
  });

  expect(
    useScopeSurfaceStore.getState().surfaceByOwnerKey["collection:root:tasks"],
  ).toBe("routines");
  useScopeSurfaceStore
    .getState()
    .applyOpenRequest("collection:root:tasks", 1, "collection");
  expect(
    useScopeSurfaceStore.getState().surfaceByOwnerKey["collection:root:tasks"],
  ).toBe("collection");

  useScopeSurfaceStore
    .getState()
    .applyOpenRequest("collection:root:tasks", 1, "readme");
  expect(
    useScopeSurfaceStore.getState().surfaceByOwnerKey["collection:root:tasks"],
  ).toBe("collection");
});

test("keeps separate selections through owner switching", () => {
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {},
    openRequestKeyByOwnerKey: {},
  });
  const store = useScopeSurfaceStore.getState();

  store.setSurface("space:root", "routines");
  store.setSurface("collection:root:tasks", "collection");
  store.setSurface("space:root", "agent");

  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "space:root": "agent",
    "collection:root:tasks": "collection",
  });
});
