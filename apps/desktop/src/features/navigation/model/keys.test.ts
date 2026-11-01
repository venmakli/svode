import { expect, test } from "bun:test";

import {
  agentActorNavigationKey,
  contextItemNavigationKey,
  isNavigationItemKey,
  navigationKeyId,
  navigationRoutineId,
  pathNavigationKey,
  personNavigationKey,
  routineNavigationKey,
  sameNavigationKey,
} from "./keys";

test("item keys carry the identity at the owner of their domain", () => {
  expect(routineNavigationKey("root", ".", "daily", "root")).toEqual({
    kind: "routine",
    ownerKind: "project",
    ownerPath: ".",
    routineId: "daily",
  });
  expect(routineNavigationKey("child", ".", "daily", "root")).toEqual({
    kind: "routine",
    spaceId: "child",
    ownerKind: "space",
    ownerPath: ".",
    routineId: "daily",
  });
  expect(routineNavigationKey("child", "tasks", "weekly", "root")).toEqual({
    kind: "routine",
    spaceId: "child",
    ownerKind: "collection",
    ownerPath: "tasks",
    routineId: "weekly",
  });
  expect(agentActorNavigationKey("child", "reviewer", "root")).toEqual({
    kind: "agentActor",
    spaceId: "child",
    actorId: "reviewer",
  });
  expect(personNavigationKey("root", "ann@example.com", "root")).toEqual({
    kind: "person",
    email: "ann@example.com",
  });
  expect(contextItemNavigationKey(null, "skill:review", "root")).toEqual({
    kind: "contextItem",
    itemId: "skill:review",
  });
});

test("an item key is one object per identity and never an artifact or a Routine memory", () => {
  const routine = routineNavigationKey("child", ".", "daily", "root");
  const keys = [
    routine,
    routineNavigationKey("child", "tasks", "daily", "root"),
    agentActorNavigationKey("child", "daily", "root"),
    personNavigationKey("child", "daily", "root"),
    contextItemNavigationKey("child", "daily", "root"),
    pathNavigationKey("page", "daily", "child", "root"),
  ];
  expect(new Set(keys.map(navigationKeyId)).size).toBe(keys.length);
  expect(keys.map(isNavigationItemKey)).toEqual([
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  expect(sameNavigationKey(routine, { ...routine })).toBe(true);
  // A session kept by a launch of the Routine is a different row.
  const memory = navigationRoutineId({
    key: { kind: "session", sessionId: "codex:a" },
    title: "Daily",
    routine: {
      spaceId: "child",
      ownerKind: "space",
      ownerPath: ".",
      routineId: "daily",
    },
  });
  expect(memory === navigationKeyId(routine)).toBe(false);
});
