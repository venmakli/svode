import { expect, test } from "bun:test";
import { useScopeSurfaceStore } from "./surface-store";

test("surface selection is session-only and keyed by stable owner identity", () => {
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {},
    openRequestKeyByOwnerKey: {},
  });

  useScopeSurfaceStore.getState().setSurface("space:root", "readme");
  useScopeSurfaceStore.getState().setSurface("collection:root:tasks", "pages");

  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "space:root": "readme",
    "collection:root:tasks": "pages",
  });

  useScopeSurfaceStore.getState().clearSurface("space:root");
  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "collection:root:tasks": "pages",
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
    .applyOpenRequest("collection:root:tasks", 1, "pages");
  expect(
    useScopeSurfaceStore.getState().surfaceByOwnerKey["collection:root:tasks"],
  ).toBe("pages");

  useScopeSurfaceStore
    .getState()
    .applyOpenRequest("collection:root:tasks", 1, "readme");
  expect(
    useScopeSurfaceStore.getState().surfaceByOwnerKey["collection:root:tasks"],
  ).toBe("pages");
});

test("keeps separate selections through owner switching", () => {
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {},
    openRequestKeyByOwnerKey: {},
  });
  const store = useScopeSurfaceStore.getState();

  store.setSurface("space:root", "routines");
  store.setSurface("collection:root:tasks", "pages");
  store.setSurface("space:root", "context");

  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "space:root": "context",
    "collection:root:tasks": "pages",
  });
});

test("retargets the active surface session to a renamed owner", () => {
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: { "collection:root:tasks": "readme" },
    openRequestKeyByOwnerKey: { "collection:root:tasks": 7 },
  });

  useScopeSurfaceStore
    .getState()
    .retargetOwner("collection:root:tasks", "collection:root:Задачи");

  expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
    "collection:root:Задачи": "readme",
  });
  expect(useScopeSurfaceStore.getState().openRequestKeyByOwnerKey).toEqual({
    "collection:root:Задачи": 7,
  });
});
