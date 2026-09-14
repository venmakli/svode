import { expect, test } from "bun:test";
import {
  createTreeExpansionCoordinator,
  projectExpansionPaths,
  remapTreePath,
} from "../src/features/space/model/tree-expansion-state";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const remap = (from: string, to: string) => (paths: string[]) =>
  projectExpansionPaths(paths.map((path) => remapTreePath(path, from, to)));
for (const childFirst of [true, false]) {
  test(`delayed hydrate and nested rename childFirst=${childFirst}`, async () => {
    const read = deferred<string[]>();
    const disk = { theme: "dark", expandedPaths: [] as string[] };
    let visible: string[] = [];
    const coordinator = createTreeExpansionCoordinator({
      read: () => read.promise,
      write: async (_scope, paths) => {
        disk.expandedPaths = paths;
      },
      publish: (_scope, paths) => {
        visible = paths;
      },
      project: (_scope, paths) => projectExpansionPaths(paths),
    });
    const loading = coordinator.load("space");
    if (childFirst) {
      coordinator.update("space", remap("a/b", "a/Дочь"));
      coordinator.update("space", remap("a", "Родитель"));
    } else {
      coordinator.update("space", remap("a", "Родитель"));
      coordinator.update("space", remap("Родитель/b", "Родитель/Дочь"));
    }
    coordinator.update("space", remap("a", "Родитель"));
    read.resolve([
      "a",
      "a/README.md",
      "a/b/README.md",
      "a/b/unloaded",
      "ab",
      "sibling",
    ]);
    await loading;
    await coordinator.load("space");
    expect(visible).toEqual([
      "Родитель",
      "Родитель/Дочь/README.md",
      "Родитель/Дочь/unloaded",
      "ab",
      "sibling",
    ]);
    expect(disk).toEqual({ theme: "dark", expandedPaths: visible });
  });
}
test("serialized writes coalesce latest state and isolate repositories", async () => {
  const first = deferred<void>();
  const writes: Array<[string, string[]]> = [];
  const disk = new Map<string, string[]>();
  const coordinator = createTreeExpansionCoordinator({
    read: async () => ["old", "old/child"],
    project: (_scope, paths) => paths,
    publish: () => {},
    write: async (scope, paths) => {
      writes.push([scope, paths]);
      if (writes.length === 1) await first.promise;
      disk.set(scope, paths);
    },
  });
  await coordinator.load("one");
  coordinator.update("one", remap("old", "middle"));
  coordinator.update("one", remap("middle", "new"));
  coordinator.update("one", (paths) =>
    paths.filter((path) => path !== "new/child"),
  );
  coordinator.update("two", () => ["other"]);
  await tick();
  expect(writes.filter(([scope]) => scope === "one")).toHaveLength(1);
  first.resolve();
  await coordinator.load("one");
  expect(disk.get("one")).toEqual(["new"]);
  expect(disk.get("two")).toEqual(["other"]);
  expect(writes.filter(([scope]) => scope === "one")).toHaveLength(2);
});
test("save failure retains runtime and retries on next normal attempt", async () => {
  let attempts = 0;
  let visible: string[] = [];
  let persisted: string[] = [];
  const coordinator = createTreeExpansionCoordinator({
    read: async () => ["old"],
    project: (_scope, paths) => paths,
    publish: (_scope, paths) => {
      visible = paths;
    },
    write: async (_scope, paths) => {
      if (++attempts === 1) throw new Error("fixture IO error");
      persisted = paths;
    },
  });
  await coordinator.load("space");
  coordinator.update("space", remap("old", "new"));
  await tick();
  expect(attempts).toBe(1);
  expect(visible).toEqual(["new"]);
  await coordinator.load("space");
  expect(persisted).toEqual(["new"]);
  expect(attempts).toBe(2);
});
test("toggle/reveal/collapse wins over delayed hydrate", async () => {
  const read = deferred<string[]>();
  let visible: string[] = [];
  const coordinator = createTreeExpansionCoordinator({
    read: () => read.promise,
    write: async () => {},
    project: (_scope, paths) => paths,
    publish: (_scope, paths) => {
      visible = paths;
    },
  });
  const loading = coordinator.load("space");
  coordinator.update("space", (paths) => [...paths, "revealed"]);
  coordinator.update("space", () => []);
  coordinator.update("space", (paths) => [...paths, "last"]);
  read.resolve(["old", "old/nested"]);
  await loading;
  expect(visible).toEqual(["last"]);
});
