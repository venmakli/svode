import { expect, test } from "bun:test";
import { upsertSpaceSnapshot, useSpaceStore } from "./space-store";
import type { SpaceInfo } from "./types";

test("schema capability action updates root and child space projections", () => {
  useSpaceStore.setState({
    rootSpaces: [space("root", "/repo")],
    spaces: [space("child", "/repo/child")],
  });

  useSpaceStore.getState().patchSpaceSchemaCapability("root", true);
  useSpaceStore.getState().patchSpaceSchemaCapability("child", true);

  expect(useSpaceStore.getState().rootSpaces[0]?.hasSchema).toBe(true);
  expect(useSpaceStore.getState().spaces[0]?.hasSchema).toBe(true);
});

test("opening a project replaces a stale registry capability snapshot", () => {
  const stale = space("root", "/repo");
  const refreshed = { ...stale, hasSchema: true };

  expect(upsertSpaceSnapshot([stale], refreshed)).toEqual([refreshed]);
});

function space(id: string, path: string): SpaceInfo {
  return {
    id,
    name: id,
    icon: "",
    description: "",
    path,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  };
}
