import { expect, test } from "bun:test";
import { coalesceByKey } from "./coalesce-by-key";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("calls during a run share one follow-up run per key", async () => {
  const runs: Array<{
    key: string;
    reply: ReturnType<typeof deferred<number>>;
  }> = [];
  const run = coalesceByKey((key: string) => {
    const reply = deferred<number>();
    runs.push({ key, reply });
    return reply.promise;
  });

  const first = run("a");
  const other = run("b");
  const waiting = Array.from({ length: 10 }, () => run("a"));
  expect(runs.map((entry) => entry.key)).toEqual(["a", "b"]);

  runs[0].reply.resolve(1);
  expect(await first).toBe(1);
  await settle();
  expect(runs.map((entry) => entry.key)).toEqual(["a", "b", "a"]);

  runs[2].reply.resolve(2);
  expect(await Promise.all(waiting)).toEqual(Array(10).fill(2));
  runs[1].reply.resolve(3);
  expect(await other).toBe(3);

  // Idle again: the next call runs at once.
  void run("a");
  expect(runs.length).toBe(4);
});

test("a failed run still starts the follow-up and keeps its own failure", async () => {
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const run = coalesceByKey((_: string) => {
    const reply = deferred<string>();
    replies.push(reply);
    return reply.promise;
  });

  const first = run("a");
  const next = run("a");
  replies[0].reject(new Error("offline"));
  expect(await first.catch((error: Error) => error.message)).toBe("offline");
  await settle();
  expect(replies.length).toBe(2);
  replies[1].resolve("read");
  expect(await next).toBe("read");
});
