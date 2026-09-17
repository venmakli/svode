import { expect, test } from "bun:test";

import type { RepositoryAccessSnapshot } from "./repository-access";
import { RepositoryAccessOwner } from "./repository-access-owner";

test("one repository owner deduplicates root and inline verification", async () => {
  let verifyCalls = 0;
  let finishVerify!: (snapshot: RepositoryAccessSnapshot) => void;
  const owner = new RepositoryAccessOwner({
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
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
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
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
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
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
      activate: async () => {
        throw new Error("Passive consumers must not activate");
      },
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
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
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
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
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

test("a delayed local read cannot end verification or erase its failure", async () => {
  for (const failRead of [false, true]) {
    const read = deferred<RepositoryAccessSnapshot>();
    const verify = deferred<RepositoryAccessSnapshot>();
    let reads = 0;
    const owner = new RepositoryAccessOwner({
      activate: async () => {
        throw new Error("Passive consumers must not activate");
      },
      listen: async () => () => undefined,
      load: async () =>
        ++reads === 1 ? snapshot(1, "unknown", "expired") : read.promise,
      verify: () => verify.promise,
    });
    await owner.refresh("/project");
    const pendingRead = owner.refresh("/project");
    const pendingVerify = owner.verify("/project");
    if (failRead) read.reject(new Error("old read failure"));
    else read.resolve(snapshot(1, "unknown", "expired"));
    await pendingRead;
    expect(owner.getSnapshot("/project").verifying).toBe(true);
    expect(owner.getSnapshot("/project").error).toBeNull();
    verify.reject(new Error("verification failed"));
    await pendingVerify;
    expect(owner.getSnapshot("/project").error).toBe("verification failed");
    expect(owner.getSnapshot("/project").verifying).toBe(false);
    owner.dispose();
  }
});

test("late read results cannot replace a completed verify result or error", async () => {
  for (const failure of [false, true]) {
    const read = deferred<RepositoryAccessSnapshot>();
    const verify = deferred<RepositoryAccessSnapshot>();
    let reads = 0;
    const owner = new RepositoryAccessOwner({
      activate: async () => {
        throw new Error("Passive consumers must not activate");
      },
      listen: async () => () => undefined,
      load: async () =>
        ++reads === 1 ? snapshot(1, "unknown", "expired") : read.promise,
      verify: () => verify.promise,
    });
    await owner.refresh("/project");
    const pendingVerify = owner.verify("/project");
    const pendingRead = owner.refresh("/project");
    if (failure) verify.reject(new Error("verification failed"));
    else verify.resolve(snapshot(3, "writable"));
    await pendingVerify;
    read.resolve(snapshot(2, "checking"));
    await pendingRead;
    expect(owner.getSnapshot("/project").verifying).toBe(false);
    expect(owner.getSnapshot("/project").error).toBe(
      failure ? "verification failed" : null,
    );
    expect(owner.getSnapshot("/project").snapshot?.status).toBe(
      failure ? "unknown" : "writable",
    );
    owner.dispose();
  }
});

test("a failed canonical read reaches every alias and explicit retry recovers all", async () => {
  let failed = false;
  const owner = new RepositoryAccessOwner({
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
    listen: async () => () => undefined,
    load: async () => {
      if (failed) throw new Error("read failed");
      return snapshot(1, "writable");
    },
    verify: async () => snapshot(2, "writable"),
  });
  await owner.refresh("/project");
  await owner.refresh("/project/inline");
  failed = true;
  await owner.refresh("/project/inline");
  expect(owner.getSnapshot("/project").error).toBe("read failed");
  expect(owner.getSnapshot("/project/inline").error).toBe("read failed");
  await owner.verify("/project");
  expect(owner.getSnapshot("/project/inline").error).toBeNull();
  owner.dispose();
});

test("invalidation during a read queues one fresh read for positive push evidence", async () => {
  const read = deferred<RepositoryAccessSnapshot>();
  let calls = 0;
  let verifies = 0;
  const owner = new RepositoryAccessOwner({
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
    listen: async () => () => undefined,
    load: async () => {
      calls++;
      if (calls === 2) return read.promise;
      return snapshot(calls, calls === 1 ? "unknown" : "writable");
    },
    verify: async () => {
      verifies++;
      return snapshot(4, "writable");
    },
  });
  await owner.refresh("/project");
  const pending = owner.refresh("/project");
  owner.handleInvalidation("repo-shared");
  owner.handleInvalidation("repo-shared");
  read.resolve(snapshot(1, "unknown"));
  await pending;
  await settle();
  expect(calls).toBe(3);
  expect(verifies).toBe(0);
  expect(owner.getSnapshot("/project").snapshot?.status).toBe("writable");
  owner.dispose();
});

test("a late verification error cannot undo newer positive push evidence", async () => {
  const verify = deferred<RepositoryAccessSnapshot>();
  let published = false;
  const owner = new RepositoryAccessOwner({
    activate: async () => {
      throw new Error("Passive consumers must not activate");
    },
    listen: async () => () => undefined,
    load: async () =>
      snapshot(published ? 3 : 1, published ? "writable" : "unknown"),
    verify: () => verify.promise,
  });
  await owner.refresh("/project");
  const pending = owner.verify("/project");
  published = true;
  await owner.refresh("/project");
  verify.reject(new Error("old probe failed"));
  await pending;
  expect(owner.getSnapshot("/project").snapshot?.status).toBe("writable");
  expect(owner.getSnapshot("/project").error).toBeNull();
  expect(owner.getSnapshot("/project").verifying).toBe(false);
  owner.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

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

test("only active repositories request lifecycle; leaving cancels delayed activation", async () => {
  const loaded = deferred<RepositoryAccessSnapshot>();
  const calls: string[] = [];
  const owner = new RepositoryAccessOwner({
    activate: async (path) => {
      calls.push(path);
      return snapshot(2, "unknown");
    },
    load: (path) =>
      path === "/leaving"
        ? loaded.promise
        : Promise.resolve({ ...snapshot(1, "local"), repositoryId: path }),
    verify: async () => snapshot(3, "writable"),
    listen: async () => () => undefined,
  });
  owner.retain("/passive-sibling");
  await owner.activate("/passive-sibling");
  const release = owner.retainActive("/leaving");
  release();
  loaded.resolve(snapshot(1, "unknown"));
  await settle();
  expect(calls).toEqual([]);
  const leave = owner.retainActive("/active");
  await settle();
  expect(calls).toEqual(["/active"]);
  leave();
  await owner.activate("/active");
  expect(calls).toEqual(["/active"]);
  owner.dispose();
});

test("automatic checking fans out to passive inline readers and manual requests join", async () => {
  const pending = deferred<RepositoryAccessSnapshot>();
  let current = snapshot(1, "unknown", "not_checked");
  let event!: (id: string) => void;
  let automatic = 0;
  let manual = 0;
  const owner = new RepositoryAccessOwner({
    activate: () => {
      automatic++;
      current = snapshot(2, "checking");
      event("repo-shared");
      return pending.promise;
    },
    load: async () => current,
    verify: async () => {
      manual++;
      return pending.promise;
    },
    listen: async (handler) => {
      event = handler;
      return () => undefined;
    },
  });
  await owner.refresh("/project/inline");
  const leave = owner.retainActive("/project");
  await settle();
  await settle();
  expect(owner.getSnapshot("/project/inline").snapshot?.status).toBe(
    "checking",
  );
  const joined = owner.verify("/project/inline");
  current = snapshot(3, "writable");
  pending.resolve(current);
  await joined;
  expect(automatic).toBe(1);
  expect(manual).toBe(1);
  expect(owner.getSnapshot("/project/inline").snapshot).toBe(
    owner.getSnapshot("/project").snapshot,
  );
  leave();
  owner.dispose();
});

test("expiry activates only active repository; fresh activation never flashes checking", async () => {
  let now = 990;
  let activated = 0;
  const owner = new RepositoryAccessOwner(
    {
      activate: async (path) => {
        activated++;
        return { ...snapshot(2, "writable"), repositoryId: path, expiresAt: 1 };
      },
      load: async (path) => ({
        ...snapshot(
          now < 1000 ? 1 : 3,
          now < 1000 ? "writable" : "unknown",
          now < 1000 ? null : "expired",
        ),
        repositoryId: path,
        expiresAt: 1,
      }),
      verify: async () => snapshot(4, "writable"),
      listen: async () => () => undefined,
    },
    () => now,
  );
  const leave = owner.retainActive("/active");
  await owner.refresh("/passive");
  await settle();
  expect(owner.getSnapshot("/active").verifying).toBe(false);
  expect(activated).toBe(1);
  now = 1000;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(activated).toBe(2);
  leave();
  owner.dispose();
});

test("automatic persistence error preserves manual recovery", async () => {
  let manual = 0;
  const owner = new RepositoryAccessOwner({
    activate: async () => {
      throw new Error("Cannot persist access reservation");
    },
    load: async () => snapshot(1, "unknown", "not_checked"),
    verify: async () => {
      manual++;
      return snapshot(2, "writable");
    },
    listen: async () => () => undefined,
  });
  const leave = owner.retainActive("/active");
  await settle();
  expect(owner.getSnapshot("/active").error).toBe(
    "Cannot persist access reservation",
  );
  expect(manual).toBe(0);
  expect(owner.getSnapshot("/active").verifying).toBe(false);
  await owner.verify("/active");
  expect(manual).toBe(1);
  expect(owner.getSnapshot("/active").error).toBeNull();
  leave();
  owner.dispose();
});

test("manual retry is not swallowed by an in-flight automatic no-op", async () => {
  const automatic = deferred<RepositoryAccessSnapshot>();
  const manual = deferred<RepositoryAccessSnapshot>();
  let manualCalls = 0;
  const owner = new RepositoryAccessOwner({
    activate: () => automatic.promise,
    load: async () => snapshot(1, "unknown", "auth_required"),
    verify: () => {
      manualCalls++;
      return manual.promise;
    },
    listen: async () => () => undefined,
  });
  const leave = owner.retainActive("/active");
  await settle();
  const retry = owner.verify("/active");
  automatic.resolve(snapshot(1, "unknown", "auth_required"));
  await settle();
  expect(manualCalls).toBe(1);
  expect(owner.getSnapshot("/active").verifying).toBe(true);
  manual.resolve(snapshot(2, "writable"));
  await retry;
  expect(owner.getSnapshot("/active").snapshot?.status).toBe("writable");
  expect(owner.getSnapshot("/active").verifying).toBe(false);
  leave();
  owner.dispose();
});
