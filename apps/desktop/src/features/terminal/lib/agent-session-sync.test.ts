import { expect, test } from "bun:test";
import {
  createInvalidationGuard,
  createKeyedSingleFlight,
  startCompletionDrivenPolling,
} from "@/features/terminal/lib/agent-session-sync";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test("terminal agent session sync coalesces requests per project", async () => {
  const singleFlight = createKeyedSingleFlight<boolean>();
  const pending = deferred<boolean>();
  let calls = 0;
  const task = () => {
    calls += 1;
    return pending.promise;
  };

  const first = singleFlight.run("/project", task);
  const second = singleFlight.run("/project", task);
  await flushPromises();

  expect(first).toBe(second);
  expect(calls).toBe(1);

  pending.resolve(true);
  expect(await first).toBe(true);
  expect(await second).toBe(true);

  let nextCalls = 0;
  await singleFlight.run("/project", async () => {
    nextCalls += 1;
    return false;
  });
  expect(nextCalls).toBe(1);
});

test("terminal sync invalidation rejects completions from an older root", () => {
  const guard = createInvalidationGuard();
  const oldRootToken = guard.capture();

  expect(guard.isCurrent(oldRootToken)).toBe(true);
  guard.invalidate();

  expect(guard.isCurrent(oldRootToken)).toBe(false);
  expect(guard.isCurrent(guard.capture())).toBe(true);
});

test("terminal polling waits for completion before scheduling again", async () => {
  const first = deferred<void>();
  const scheduled: Array<() => void> = [];
  let calls = 0;

  const stop = startCompletionDrivenPolling({
    intervalMs: 5_000,
    task: () => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve();
    },
    setTimeout: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout: () => {},
  });
  await flushPromises();

  expect(calls).toBe(1);
  expect(scheduled.length).toBe(0);

  first.resolve();
  await flushPromises();
  expect(scheduled.length).toBe(1);

  scheduled.shift()?.();
  await flushPromises();
  expect(calls).toBe(2);

  stop();
});

test("stopping an active terminal poll prevents later cycles", async () => {
  const first = deferred<void>();
  const scheduled: Array<() => void> = [];

  const stop = startCompletionDrivenPolling({
    intervalMs: 5_000,
    task: () => first.promise,
    setTimeout: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout: () => {},
  });
  await flushPromises();

  stop();
  first.resolve();
  await flushPromises();

  expect(scheduled.length).toBe(0);
});
