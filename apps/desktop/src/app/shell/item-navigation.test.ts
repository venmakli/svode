import { expect, test } from "bun:test";

import type { ScopeItemRef } from "@/features/scope-surfaces";
import type { ScopeOwnerTarget } from "@/features/artifact";
import type { NavigationItemKey } from "@/features/navigation";

import { itemNavigationKey, itemNavigationTarget } from "./item-navigation";

const cases: Array<{ owner: ScopeOwnerTarget; item: ScopeItemRef }> = [
  {
    owner: { kind: "space", spaceId: "root" },
    item: { surfaceId: "routines", itemId: "daily" },
  },
  {
    owner: { kind: "collection", spaceId: "child", path: "tasks" },
    item: { surfaceId: "routines", itemId: "weekly" },
  },
  {
    owner: { kind: "space", spaceId: "child" },
    item: { surfaceId: "actors", presentationId: "agents", itemId: "reviewer" },
  },
  {
    owner: { kind: "space", spaceId: "child" },
    item: {
      surfaceId: "actors",
      presentationId: "humans",
      itemId: "ann@example.com",
    },
  },
  {
    owner: { kind: "space", spaceId: "root" },
    item: { surfaceId: "context", itemId: "skill:review" },
  },
];

test("an item key opens the item expanded over the owner it came from", () => {
  for (const { owner, item } of cases) {
    const key = itemNavigationKey(owner, item, "root") as NavigationItemKey;
    expect(itemNavigationTarget(key, "root")).toEqual({ owner, item });
  }
});

test("surfaces without expandable items give no key", () => {
  expect(
    itemNavigationKey(
      { kind: "space", spaceId: "root" },
      { surfaceId: "sessions", itemId: "codex:a" },
      "root",
    ),
  ).toBe(null);
});
