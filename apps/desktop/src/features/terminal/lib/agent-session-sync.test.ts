import { expect, test } from "bun:test";
import {
  createInvalidationGuard,
  createLatestTaskQueue,
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

test("terminal agent session sync applies only the latest waiting input", async () => {
  const queue = createLatestTaskQueue<string>();
  const first = deferred<string>();
  const calls: string[] = [];

  const running = queue.run(() => {
    calls.push("first");
    return first.promise;
  });
  const replaced = queue.run(async () => {
    calls.push("replaced");
    return "replaced";
  });
  const latest = queue.run(async () => {
    calls.push("latest");
    return "latest";
  });
  await flushPromises();

  expect(replaced).toBe(latest);
  expect(calls).toEqual(["first"]);

  first.resolve("first");
  expect(await running).toBe("first");
  expect(await latest).toBe("latest");
  expect(calls).toEqual(["first", "latest"]);

  expect(await queue.run(async () => "idle")).toBe("idle");
});

test("terminal sync invalidation rejects completions from an older root", () => {
  const guard = createInvalidationGuard();
  const oldRootToken = guard.capture();

  expect(guard.isCurrent(oldRootToken)).toBe(true);
  guard.invalidate();

  expect(guard.isCurrent(oldRootToken)).toBe(false);
  expect(guard.isCurrent(guard.capture())).toBe(true);
});
