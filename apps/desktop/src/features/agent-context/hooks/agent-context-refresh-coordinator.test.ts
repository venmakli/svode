import { expect, test } from "bun:test";

import {
  AgentContextRefreshCoordinator,
  type AgentContextRefreshScheduler,
} from "./agent-context-refresh-coordinator";

test("burst invalidations debounce into one refresh", async () => {
  const scheduler = createManualScheduler();
  const request = deferred<string>();
  const loads: string[] = [];
  const published: string[] = [];
  const coordinator = new AgentContextRefreshCoordinator({
    debounceMs: 120,
    load: (kind) => {
      loads.push(kind);
      return request.promise;
    },
    onFailure: () => undefined,
    onSuccess: (snapshot) => published.push(snapshot),
    scheduler,
  });

  coordinator.invalidate();
  coordinator.invalidate();
  coordinator.invalidate();
  expect(loads).toEqual([]);

  scheduler.flush();
  await flushMicrotasks();
  expect(loads).toEqual(["refresh"]);

  request.resolve("generation:2");
  await flushMicrotasks();
  expect(published).toEqual(["generation:2"]);
});

test("an in-flight burst discards the obsolete result and runs one trailing load", async () => {
  const requests = [deferred<string>(), deferred<string>()];
  const loads: string[] = [];
  const published: string[] = [];
  const coordinator = new AgentContextRefreshCoordinator({
    debounceMs: 120,
    load: (kind) => {
      loads.push(kind);
      return requests[loads.length - 1]!.promise;
    },
    onFailure: () => undefined,
    onSuccess: (snapshot) => published.push(snapshot),
  });

  coordinator.loadInitial();
  await flushMicrotasks();
  coordinator.invalidate();
  coordinator.invalidate();
  coordinator.invalidate();
  expect(loads).toEqual(["initial"]);

  requests[0]!.resolve("obsolete");
  await flushMicrotasks();
  expect(loads).toEqual(["initial", "refresh"]);
  expect(published).toEqual([]);

  requests[1]!.resolve("current");
  await flushMicrotasks();
  expect(published).toEqual(["current"]);
});

test("disposing an owner prevents its late result from publishing", async () => {
  const oldRequest = deferred<string>();
  const nextRequest = deferred<string>();
  const published: string[] = [];
  const oldOwner = new AgentContextRefreshCoordinator({
    debounceMs: 120,
    load: () => oldRequest.promise,
    onFailure: () => undefined,
    onSuccess: (snapshot) => published.push(snapshot),
  });
  const nextOwner = new AgentContextRefreshCoordinator({
    debounceMs: 120,
    load: () => nextRequest.promise,
    onFailure: () => undefined,
    onSuccess: (snapshot) => published.push(snapshot),
  });

  oldOwner.loadInitial();
  await flushMicrotasks();
  oldOwner.dispose();
  nextOwner.loadInitial();
  await flushMicrotasks();

  nextRequest.resolve("owner:b");
  oldRequest.resolve("owner:a");
  await flushMicrotasks();
  expect(published).toEqual(["owner:b"]);
});

test("retry uses the same coordinator after a failed load", async () => {
  const requests = [deferred<string>(), deferred<string>()];
  const failures: unknown[] = [];
  const published: string[] = [];
  let loadCount = 0;
  const coordinator = new AgentContextRefreshCoordinator({
    debounceMs: 120,
    load: () => requests[loadCount++]!.promise,
    onFailure: (error) => failures.push(error),
    onSuccess: (snapshot) => published.push(snapshot),
  });

  coordinator.loadInitial();
  await flushMicrotasks();
  requests[0]!.reject(new Error("scan failed"));
  await flushMicrotasks();
  expect(failures.length).toBe(1);

  coordinator.retry();
  await flushMicrotasks();
  requests[1]!.resolve("recovered");
  await flushMicrotasks();
  expect(published).toEqual(["recovered"]);
});

test("an authoritative mutation snapshot supersedes a scheduled watcher echo", async () => {
  const scheduler = createManualScheduler();
  const loads: string[] = [];
  const coordinator = new AgentContextRefreshCoordinator({
    debounceMs: 120,
    load: async (kind) => {
      loads.push(kind);
      return "unexpected";
    },
    onFailure: () => undefined,
    onSuccess: () => undefined,
    scheduler,
  });

  const pending = coordinator.invalidate();
  coordinator.supersede();
  scheduler.flush();

  expect(await pending).toBe(null);
  expect(loads).toEqual([]);
});

function createManualScheduler(): AgentContextRefreshScheduler & {
  flush(): void;
} {
  const tasks: Array<{ active: boolean; run(): void }> = [];
  return {
    flush() {
      for (const task of tasks.splice(0)) {
        if (task.active) task.run();
      }
    },
    schedule(run) {
      const task = { active: true, run };
      tasks.push(task);
      return () => {
        task.active = false;
      };
    },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}
