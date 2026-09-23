import { expect, test } from "bun:test";

import type {
  Page,
  PageSourceConflict,
  WritePageResult,
} from "@/features/page";

import type { DocumentSourceBaseline } from "./plate-document-cache";
import { createSourceSync, retryWhileSourceBusy } from "./source-sync";

const PATH = "notes/today.md";

function page(body: string, version: string, title = "Today"): Page {
  return {
    meta: { title, icon: null, created: "", updated: "", extra: {} },
    body,
    path: PATH,
    source_version: version,
  };
}

function written(version: string): WritePageResult {
  return {
    newPath: null,
    modifiedFiles: [],
    writeNonce: "nonce",
    warnings: [],
    sourceVersion: version,
  };
}

function staleError() {
  return { kind: "source_stale", path: PATH };
}

function harness({
  baseline = { version: "v1", body: "Loaded\n" },
  draft = true,
}: { baseline?: DocumentSourceBaseline | null; draft?: boolean } = {}) {
  const state = {
    baseline,
    draft,
    disk: page("Loaded\n", "v1"),
    readFails: false,
    paused: false,
    conflict: null as PageSourceConflict | null,
    loaded: [] as Page[],
    metadata: [] as Page[],
    writes: [] as string[],
    resolved: [] as string[],
    writeResult: async (version: string): Promise<WritePageResult | null> => {
      if (version !== state.disk.source_version) throw staleError();
      state.disk = page("Draft\n", `${version}+draft`);
      return written(state.disk.source_version!);
    },
  };
  const sync = createSourceSync({
    baseline: () => state.baseline,
    setBaseline: (_path, next) => {
      state.baseline = next;
    },
    hasDraft: () => state.draft,
    whenWritesSettled: async () => {},
    readSource: async () => {
      if (state.readFails) throw new Error("unreadable");
      return state.disk;
    },
    loadSource: (_path, loaded) => {
      state.loaded.push(loaded);
      state.baseline = {
        version: loaded.source_version!,
        body: loaded.body,
      };
      state.draft = false;
    },
    adoptMetadata: (source) => state.metadata.push(source),
    writeDraft: async (_path, version) => {
      state.writes.push(version);
      return state.writeResult(version);
    },
    setAutoSavePaused: (paused) => {
      state.paused = paused;
    },
    report: (conflict) => {
      state.conflict = conflict;
    },
    onResolved: (choice) => state.resolved.push(choice),
  });
  return { state, sync };
}

function conflictState(conflict: PageSourceConflict | null) {
  if (!conflict) return null;
  const { status, failure, pending } = conflict;
  return { status, failure, pending };
}

async function refusal(write: () => Promise<unknown>) {
  try {
    await write();
    return null;
  } catch (error) {
    return (error as { kind?: string }).kind ?? null;
  }
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

test("an external change without a draft reloads the source", async () => {
  const { state, sync } = harness({ draft: false });
  state.disk = page("From CLI\n", "v2");

  expect(await sync.reconcile(PATH, "external")).toBe("reloaded");
  expect(state.loaded.map((loaded) => loaded.body)).toEqual(["From CLI\n"]);
  expect(state.conflict).toBeNull();
});

test("the echo of an own write is the current source", async () => {
  const { state, sync } = harness();

  expect(await sync.reconcile(PATH, "external")).toBe("current");
  expect(state.loaded).toEqual([]);
  expect(state.conflict).toBeNull();
});

test("a metadata change under a draft keeps the draft and adopts the new version", async () => {
  const { state, sync } = harness();
  state.disk = page("Loaded\n", "v2", "Renamed");

  expect(await sync.reconcile(PATH, "external")).toBe("rebased");
  expect(state.baseline).toEqual({ version: "v2", body: "Loaded\n" });
  expect(state.metadata.map((source) => source.meta.title)).toEqual([
    "Renamed",
  ]);
  expect(state.conflict).toBeNull();
  expect(state.paused).toBe(false);
});

test("a body change under a draft opens the recovery without reloading", async () => {
  const { state, sync } = harness();
  state.disk = page("From CLI\n", "v2");

  expect(await sync.reconcile(PATH, "external")).toBe("conflict");
  expect(state.loaded).toEqual([]);
  expect(state.paused).toBe(true);
  expect(state.conflict?.status).toBe("ready");
  expect(sync.isOpen()).toBe(true);
});

test("a stale write whose body changed is a conflict; bounded rebases also end in one", async () => {
  const changed = harness();
  changed.state.disk = page("From CLI\n", "v2");
  expect(await changed.sync.reconcile(PATH, "stale")).toBe("conflict");

  const unchanged = harness();
  unchanged.state.disk = page("Loaded\n", "v2");
  expect(await unchanged.sync.reconcile(PATH, "stale")).toBe("rebased");
  unchanged.state.disk = page("Loaded\n", "v3");
  expect(await unchanged.sync.reconcile(PATH, "stale", { rebase: false })).toBe(
    "conflict",
  );
});

test("saving my text writes the draft from the shown baseline and resumes autosave", async () => {
  const { state, sync } = harness();
  state.disk = page("From CLI\n", "v2");
  await sync.reconcile(PATH, "stale");

  state.conflict!.writeDraft();
  await settle();

  expect(state.writes).toEqual(["v2"]);
  expect(state.conflict).toBeNull();
  expect(state.paused).toBe(false);
  expect(state.resolved).toEqual(["written"]);
});

test("a change between showing and choosing is stale again and keeps the draft", async () => {
  const { state, sync } = harness();
  state.disk = page("From CLI\n", "v2");
  await sync.reconcile(PATH, "stale");

  state.disk = page("From CLI again\n", "v3");
  // Watcher events while the choice is shown keep its baseline.
  expect(await sync.reconcile(PATH, "external")).toBe("conflict");
  state.conflict!.writeDraft();
  await settle();

  expect(state.writes).toEqual(["v2"]);
  expect(state.disk.body).toBe("From CLI again\n");
  expect(conflictState(state.conflict)).toEqual({
    status: "ready",
    failure: "changed_again",
    pending: null,
  });
  expect(state.paused).toBe(true);
  expect(state.loaded).toEqual([]);

  state.conflict!.writeDraft();
  await settle();
  expect(state.writes).toEqual(["v2", "v3"]);
  expect(state.conflict).toBeNull();
});

test("loading the file version replaces the draft with a fresh read", async () => {
  const { state, sync } = harness();
  state.disk = page("From CLI\n", "v2");
  await sync.reconcile(PATH, "stale");
  state.disk = page("Latest\n", "v3");

  state.conflict!.loadFile();
  await settle();

  expect(state.loaded.map((loaded) => loaded.body)).toEqual(["Latest\n"]);
  expect(state.baseline).toEqual({ version: "v3", body: "Latest\n" });
  expect(state.conflict).toBeNull();
  expect(state.resolved).toEqual(["loaded"]);
});

test("a failed read keeps the draft in recovery until a read succeeds", async () => {
  const { state, sync } = harness();
  state.disk = page("From CLI\n", "v2");
  state.readFails = true;

  expect(await sync.reconcile(PATH, "stale")).toBe("conflict");
  expect(state.conflict?.status).toBe("read_failed");
  state.conflict!.writeDraft();
  state.conflict!.loadFile();
  await settle();
  expect(state.writes).toEqual([]);
  expect(state.conflict?.failure).toBe("load");
  expect(state.loaded).toEqual([]);

  state.readFails = false;
  state.conflict!.retryRead();
  await settle();
  expect(state.conflict?.status).toBe("ready");
});

test("a failed write keeps the draft and the choice", async () => {
  const { state, sync } = harness();
  state.disk = page("From CLI\n", "v2");
  await sync.reconcile(PATH, "stale");
  state.writeResult = async () => {
    throw { kind: "repository_access_denied" };
  };

  state.conflict!.writeDraft();
  await settle();

  expect(conflictState(state.conflict)).toEqual({
    status: "ready",
    failure: "write",
    pending: null,
  });
  expect(state.paused).toBe(true);
});

test("a missing baseline cannot be written over and asks for a choice", async () => {
  const { state, sync } = harness({ baseline: null });
  state.disk = page("Loaded\n", "v2");

  expect(await sync.reconcile(PATH, "stale")).toBe("conflict");
  expect(state.conflict?.status).toBe("ready");
});

test("a busy write is retried a bounded number of times, other refusals are not", async () => {
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  let attempts = 0;
  expect(
    await retryWhileSourceBusy(async () => {
      attempts += 1;
      if (attempts < 3) throw { kind: "source_busy", path: PATH };
      return "written";
    }, wait),
  ).toBe("written");
  expect(waits).toEqual([300, 1000]);

  attempts = 0;
  expect(
    await refusal(() =>
      retryWhileSourceBusy(async () => {
        attempts += 1;
        throw { kind: "source_busy", path: PATH };
      }, wait),
    ),
  ).toBe("source_busy");
  expect(attempts).toBe(3);

  attempts = 0;
  expect(
    await refusal(() =>
      retryWhileSourceBusy(async () => {
        attempts += 1;
        throw staleError();
      }, wait),
    ),
  ).toBe("source_stale");
  expect(attempts).toBe(1);
});
