import { expect, test } from "bun:test";
import { AttachmentSourceSession } from "./source-session";
import type {
  AttachmentOwnerInput,
  AttachmentRow,
  AttachmentsSnapshot,
} from "./types";

const owner: AttachmentOwnerInput = {
  projectPath: "/repo",
  spaceId: null,
  ownerPath: ".",
};
function row(
  path: string,
  kind: AttachmentRow["kind"] = "directory",
): AttachmentRow {
  return {
    key: `${kind}:${path}`,
    path,
    kind,
    ownerPath: path,
    contentPath: null,
    sourcePath: path,
    sourceShape: "directory",
    hasApp: kind === "app",
    icon: null,
    format: "",
    availability: "available",
    displayName: path,
    modified: "",
    sizeBytes: null,
  };
}
function snapshot(
  rows: AttachmentRow[],
  generation = "1",
): AttachmentsSnapshot {
  return {
    owner: { ...owner, spacePath: "/repo", repositoryPath: "/repo" },
    rows,
    generation,
    diagnostics: [],
  };
}
function harness() {
  const calls: Array<{
    input: AttachmentOwnerInput;
    resolve(value: AttachmentsSnapshot): void;
    reject(error: Error): void;
  }> = [];
  const session = new AttachmentSourceSession(
    owner,
    (input) =>
      new Promise((resolve, reject) => calls.push({ input, resolve, reject })),
    () => {},
  );
  return { session, calls };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("branches are lazy, remain collapsed after late load, and retain sibling snapshots on failure", async () => {
  const { session, calls } = harness();
  const root = session.refreshRoot();
  calls[0]!.resolve(snapshot([row("page", "page"), row("other")]));
  await root;
  expect(calls.length).toBe(1);
  session.toggle("page");
  expect(calls[1]!.input.branchPath).toBe("page");
  session.toggle("page");
  calls[1]!.resolve(snapshot([row("page/collection", "collection")]));
  await settle();
  expect(session.current.expanded.has("page")).toBe(false);
  expect(
    session
      .inventory()
      ?.rows.map((row) => row.path)
      ?.includes("page/collection"),
  ).toBe(true);
  session.toggle("page");
  calls[2]!.resolve(snapshot([row("page/collection", "collection")]));
  await settle();
  session.toggle("page/collection");
  calls[3]!.resolve(snapshot([row("page/collection/app", "app")]));
  await settle();
  session.toggle("other");
  calls[4]!.reject(new Error("unreadable"));
  await settle();
  expect(session.current.branches.get("other")?.error).toBe("unreadable");
  expect(
    session
      .inventory()
      ?.rows.map((row) => row.path)
      ?.includes("page/collection/app"),
  ).toBe(true);
  const retry = session.loadBranch("other");
  calls[5]!.resolve(snapshot([]));
  await retry;
  expect(session.current.branches.get("other")?.error).toBeNull();
  expect(session.current.branches.get("other")?.snapshot?.rows).toEqual([]);
});

test("removed or reclassified nodes prune descendants and reject their late responses", async () => {
  const { session, calls } = harness();
  const root = session.refreshRoot();
  calls[0]!.resolve(snapshot([row("folder")]));
  await root;
  session.toggle("folder");
  calls[1]!.resolve(snapshot([row("folder/child")]));
  await settle();
  session.toggle("folder/child");
  const update = session.refreshRoot();
  calls[3]!.resolve(snapshot([row("folder", "app")]));
  await update;
  calls[2]!.resolve(snapshot([row("folder/child/stale")]));
  await settle();
  expect(session.current.branches.size).toBe(0);
  expect(session.current.expanded.size).toBe(0);
  expect(session.inventory()?.rows).toEqual([row("folder", "app")]);
  session.toggle("folder");
  const removed = session.refreshRoot();
  calls[5]!.resolve(snapshot([]));
  await removed;
  calls[4]!.resolve(snapshot([row("folder/stale")]));
  await settle();
  expect(session.inventory()?.rows).toEqual([]);
});

test("newer branch and root requests win; disposed owner never publishes", async () => {
  const { session, calls } = harness();
  const oldRoot = session.refreshRoot();
  const root = session.refreshRoot();
  calls[1]!.resolve(snapshot([row("folder")]));
  await root;
  calls[0]!.resolve(snapshot([row("stale")]));
  await oldRoot;
  const oldBranch = session.loadBranch("folder");
  const branch = session.loadBranch("folder");
  calls[3]!.resolve(snapshot([row("folder/new")]));
  await branch;
  calls[2]!.resolve(snapshot([row("folder/old")]));
  await oldBranch;
  expect(session.inventory()?.rows.map((row) => row.path)).toEqual([
    "folder",
    "folder/new",
  ]);
  const late = session.loadBranch("folder");
  session.dispose();
  calls[4]!.resolve(snapshot([]));
  await late;
  expect(
    session
      .inventory()
      ?.rows.map((row) => row.path)
      ?.includes("folder/new"),
  ).toBe(true);
});

test("invalidation refreshes visible branches and Peek ancestors, defers closed branches until reopen", async () => {
  const { session, calls } = harness();
  const root = session.refreshRoot();
  calls[0]!.resolve(snapshot([row("folder")]));
  await root;
  session.toggle("folder");
  calls[1]!.resolve(snapshot([row("folder/nested")]));
  await settle();
  session.toggle("folder/nested");
  calls[2]!.resolve(snapshot([row("folder/nested/old")]));
  await settle();
  session.toggle("folder");
  session.invalidate();
  const refresh = session.refresh();
  calls[3]!.resolve(snapshot([row("folder")]));
  await refresh;
  expect(calls.length).toBe(4);
  const release = session.retainPeekTarget(row("folder/nested/old"));
  const peekRefresh = session.refresh();
  calls[4]!.resolve(snapshot([row("folder")]));
  await settle();
  calls[5]!.resolve(snapshot([row("folder/nested")]));
  await settle();
  calls[6]!.resolve(snapshot([]));
  await peekRefresh;
  expect(
    session.inventory()?.rows.some((row) => row.path.endsWith("old")),
  ).toBe(false);
  release();
  session.toggle("folder");
  calls[7]!.resolve(snapshot([row("folder/nested")]));
  await settle();
  expect(calls[8]!.input.branchPath).toBe("folder/nested");
  calls[8]!.resolve(snapshot([row("folder/nested/new")]));
  await settle();
  expect(
    session.inventory()?.rows.some((row) => row.path.endsWith("new")),
  ).toBe(true);
});

test("invalidation discards in-flight results before the coalesced reload starts", async () => {
  const { session, calls } = harness();
  const root = session.refreshRoot();
  calls[0]!.resolve(snapshot([row("folder")]));
  await root;
  session.toggle("folder");
  session.invalidate();
  calls[1]!.resolve(snapshot([row("folder/stale")]));
  await settle();
  expect(session.inventory()?.rows).toEqual([row("folder")]);
  const refresh = session.refresh();
  calls[2]!.resolve(snapshot([]));
  await refresh;
  expect(session.current.branches.size).toBe(0);
});
