import { expect, test } from "bun:test";

import type { RepositoryAccessSnapshot } from "./repository-access";
import { RepositoryAccessOwner } from "./repository-access-owner";

test("one repository owner deduplicates root and inline verification", async () => {
  let verifyCalls = 0;
  let finishVerify!: (snapshot: RepositoryAccessSnapshot) => void;
  const owner = new RepositoryAccessOwner({
    listen: async () => () => undefined,
    load: async () => snapshot(1, "unknown", "not_checked"),
    verify: () => {
      verifyCalls += 1;
      return new Promise((resolve) => {
        finishVerify = resolve;
      });
    },
  });

  await owner.refresh("/project");
  await owner.refresh("/project/inline");
  const rootVerify = owner.verify("/project");
  const inlineVerify = owner.verify("/project/inline");

  expect(rootVerify).toBe(inlineVerify);
  expect(verifyCalls).toBe(1);
  finishVerify(snapshot(2, "writable"));
  await rootVerify;
  expect(owner.getSnapshot("/project").snapshot?.status).toBe("writable");
  expect(owner.getSnapshot("/project/inline").snapshot).toBe(
    owner.getSnapshot("/project").snapshot,
  );
  owner.dispose();
});

test("late generations cannot replace a newer repository projection", async () => {
  const owner = new RepositoryAccessOwner({
    listen: async () => () => undefined,
    load: async (path) =>
      path === "/project" ? snapshot(4, "writable") : snapshot(3, "read_only"),
    verify: async () => snapshot(5, "writable"),
  });

  await owner.refresh("/project");
  await owner.refresh("/project/inline");

  expect(owner.getSnapshot("/project").snapshot?.generation).toBe(4);
  expect(owner.getSnapshot("/project/inline").snapshot?.status).toBe(
    "writable",
  );
  owner.dispose();
});

test("repository invalidation rereads canonical state across mounted paths", async () => {
  let generation = 1;
  let eventHandler!: (repositoryId: string) => void;
  const owner = new RepositoryAccessOwner({
    listen: async (handler) => {
      eventHandler = handler;
      return () => undefined;
    },
    load: async () =>
      snapshot(generation, generation === 1 ? "local" : "writable"),
    verify: async () => snapshot(generation, "writable"),
  });

  owner.retain("/project");
  await settle();
  generation = 2;
  eventHandler("repo-shared");
  await settle();

  expect(owner.getSnapshot("/project").snapshot?.generation).toBe(2);
  expect(owner.getSnapshot("/project").snapshot?.status).toBe("writable");
  owner.dispose();
});

test("future expiry triggers one local canonical reread", async () => {
  let loads = 0;
  const owner = new RepositoryAccessOwner(
    {
      listen: async () => () => undefined,
      load: async () => {
        loads += 1;
        return loads === 1
          ? { ...snapshot(1, "writable"), expiresAt: 1 }
          : snapshot(2, "unknown", "expired");
      },
      verify: async () => snapshot(3, "writable"),
    },
    () => 990,
  );

  await owner.refresh("/project");
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(loads).toBe(2);
  expect(owner.getSnapshot("/project").snapshot?.reason).toBe("expired");
  owner.dispose();
});

test("open reads locally without starting a verification probe", async () => {
  let loads = 0;
  let verifies = 0;
  const owner = new RepositoryAccessOwner({
    listen: async () => () => undefined,
    load: async () => {
      loads += 1;
      return snapshot(1, "unknown", "not_checked");
    },
    verify: async () => {
      verifies += 1;
      return snapshot(2, "writable");
    },
  });

  owner.retain("/project");
  await settle();

  expect(loads).toBe(1);
  expect(verifies).toBe(0);
  owner.dispose();
});

test("independent and submodule repositories remain isolated", async () => {
  const owner = new RepositoryAccessOwner({
    listen: async () => () => undefined,
    load: async (path) => ({
      ...snapshot(1, path.includes("independent") ? "writable" : "read_only"),
      repositoryId: path.includes("independent")
        ? "repo-independent"
        : "repo-submodule",
    }),
    verify: async () => snapshot(2, "writable"),
  });

  await owner.refresh("/project/independent");
  await owner.refresh("/project/submodule");

  expect(owner.getSnapshot("/project/independent").snapshot?.repositoryId).toBe(
    "repo-independent",
  );
  expect(owner.getSnapshot("/project/independent").snapshot?.status).toBe(
    "writable",
  );
  expect(owner.getSnapshot("/project/submodule").snapshot?.repositoryId).toBe(
    "repo-submodule",
  );
  expect(owner.getSnapshot("/project/submodule").snapshot?.status).toBe(
    "read_only",
  );
  owner.dispose();
});

function snapshot(
  generation: number,
  status: RepositoryAccessSnapshot["status"],
  reason: RepositoryAccessSnapshot["reason"] = null,
): RepositoryAccessSnapshot {
  return {
    checkedAt: status === "writable" ? 100 : null,
    expiresAt: null,
    generation,
    lastKnownStatus: null,
    reason,
    repositoryId: "repo-shared",
    status,
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
