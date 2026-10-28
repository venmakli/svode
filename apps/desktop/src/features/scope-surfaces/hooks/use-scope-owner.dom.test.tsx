import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { ScopeOwnerFacts } from "../model/owner-facts";
import type { ScopeOwnerRef } from "../model/types";
import { useScopeOwner, type ScopeOwnerStructure } from "./use-scope-owner";

const spacePath = "/space";

test("known facts render at once, siblings do not re-resolve, markers do, and a failed read offers retry instead of a reduced owner", async () => {
  const f = await fixture();
  try {
    f.facts.set("tasks", {
      identity: "collectionDirectory",
      ownerPath: "tasks",
      contentPath: "tasks/README.md",
      hasApp: false,
    });
    await f.render("tasks", {
      identity: "collection-directory",
      ownerPath: "tasks",
      contentPath: "tasks/README.md",
      hasApp: false,
    });
    // The seeded owner is shown before the resolver answered.
    expect(f.seen[0]?.owner?.capabilities).toEqual(["collection"]);
    await f.settle();
    expect(f.reads()).toBe(1);
    const resolved = f.current();

    await f.emit("file:changed", "tasks/Item.md");
    await f.emit("file:created", "tasks/New.md");
    expect(f.reads()).toBe(1);
    expect(f.current()).toBe(resolved);

    f.facts.set("tasks", { ...f.facts.get("tasks")!, hasApp: true });
    await f.emit("file:created", "tasks/app.yaml");
    expect(f.reads()).toBe(2);
    expect(f.current()?.capabilities).toEqual(["collection", "app"]);
    const withApp = f.current();

    // An unchanged answer keeps the same owner object.
    await f.emit("file:changed", "tasks/README.md");
    expect(f.reads()).toBe(3);
    expect(f.current()).toBe(withApp);

    f.fail = true;
    await f.render("Docs/README.md", null);
    await f.settle();
    expect(f.current()).toBeNull();
    expect(f.error()?.includes("facts unavailable")).toBe(true);
    f.fail = false;
    f.facts.set("Docs/README.md", {
      identity: "pageDirectory",
      ownerPath: "Docs",
      contentPath: "Docs/README.md",
      hasApp: true,
    });
    await act(async () => {
      f.retry();
      await f.tick();
    });
    expect(f.error()).toBeNull();
    expect(f.current()?.identityKind).toBe("page-directory");
    expect(f.current()?.capabilities).toEqual(["app"]);
  } finally {
    await f.cleanup();
  }
});

test("a late answer for the previous target is ignored and a retarget keeps the previous owner until it resolves", async () => {
  const f = await fixture();
  try {
    let releaseOld!: () => void;
    f.delay.set(
      "Old.md",
      new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    );
    f.facts.set("Old.md", {
      identity: "pageFile",
      ownerPath: "Old.md",
      contentPath: "Old.md",
      hasApp: false,
    });
    f.facts.set("Note/README.md", {
      identity: "pageDirectory",
      ownerPath: "Note",
      contentPath: "Note/README.md",
      hasApp: true,
    });
    await f.render("Old.md", null);
    await f.render("Note/README.md", null);
    await f.settle();
    expect(f.current()?.readmePath).toBe("Note/README.md");
    await act(async () => {
      releaseOld();
      await f.tick();
    });
    expect(f.current()?.readmePath).toBe("Note/README.md");

    f.facts.set("Moved/README.md", {
      identity: "pageDirectory",
      ownerPath: "Moved",
      contentPath: "Moved/README.md",
      hasApp: true,
    });
    let releaseMoved!: () => void;
    f.delay.set(
      "Moved/README.md",
      new Promise<void>((resolve) => {
        releaseMoved = resolve;
      }),
    );
    await f.render("Moved/README.md", null, true);
    expect(f.current()?.readmePath).toBe("Note/README.md");
    await act(async () => {
      releaseMoved();
      await f.tick();
    });
    expect(f.current()?.readmePath).toBe("Moved/README.md");
  } finally {
    await f.cleanup();
  }
});

test("a resolved owner that Svode no longer finds is gone once own structural operations finished; other failures and unknown targets are errors", async () => {
  const f = await fixture();
  try {
    const app = {
      identity: "appDirectory",
      ownerPath: "tool",
      contentPath: "tool/README.md",
      hasApp: true,
    };
    f.facts.set("tool", app);
    let finishOperation!: () => void;
    let pending = Promise.resolve();
    const structure = (revision: number): ScopeOwnerStructure => ({
      revision,
      settled: () => pending,
    });
    await f.render("tool", null, false, structure(0));
    await f.settle();
    expect(f.current()?.identityKind).toBe("app-directory");

    // An own rename is still running: the old path is not confirmed gone.
    pending = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    f.missing.add("tool");
    await f.render("tool", null, false, structure(1));
    await f.settle();
    expect(f.gone()).toBe(false);
    expect(f.error()).toBeNull();
    expect(f.current()?.identityKind).toBe("app-directory");

    // It ended and the folder is still not there: the owner is gone, and
    // stays shown until its presentation closes.
    await act(async () => {
      finishOperation();
      await f.tick();
      await f.tick();
    });
    expect(f.gone()).toBe(true);
    expect(f.error()).toBeNull();
    expect(f.current()?.identityKind).toBe("app-directory");

    // A change of the Space tree rechecks; the folder back is the owner again.
    pending = Promise.resolve();
    f.missing.delete("tool");
    const reads = f.reads();
    await f.render("tool", null, false, structure(2));
    await f.settle();
    expect(f.reads()).toBe(reads + 1);
    expect(f.gone()).toBe(false);

    // A failure to read is no absence.
    f.fail = true;
    await f.render("tool", null, false, structure(3));
    await f.settle();
    expect(f.gone()).toBe(false);
    expect(f.error()?.includes("facts unavailable")).toBe(true);
    f.fail = false;

    // A target that never resolved and is not found fails to open.
    f.missing.add("missing");
    await f.render("missing", null, false, structure(3));
    await f.settle();
    expect(f.gone()).toBe(false);
    expect(Boolean(f.error())).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("an owner retargeted while its operation runs is never confirmed gone at the old path", async () => {
  const f = await fixture();
  try {
    f.facts.set("tool", {
      identity: "appDirectory",
      ownerPath: "tool",
      contentPath: "tool/README.md",
      hasApp: true,
    });
    f.facts.set("toolbox", {
      identity: "appDirectory",
      ownerPath: "toolbox",
      contentPath: "toolbox/README.md",
      hasApp: true,
    });
    let finishOperation!: () => void;
    const structure: ScopeOwnerStructure = {
      revision: 0,
      settled: () =>
        new Promise<void>((resolve) => {
          finishOperation = resolve;
        }),
    };
    await f.render("tool", null, false, structure);
    await f.settle();
    // The folder is renamed; a watcher event reaches the old path first.
    f.missing.add("tool");
    await f.emit("file:deleted", "tool");
    await f.render("toolbox", null, true, structure);
    await act(async () => {
      finishOperation();
      await f.tick();
      await f.tick();
    });
    await f.settle();
    expect(f.seen.some((entry) => entry.gone)).toBe(false);
    expect(f.current()?.ownerPath).toBe("toolbox");
  } finally {
    await f.cleanup();
  }
});

async function fixture() {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  const facts = new Map<string, unknown>();
  const delay = new Map<string, Promise<void>>();
  // Paths Svode answers as not found.
  const missing = new Set<string>();
  let reads = 0;
  const state = { fail: false };
  mockNativeIpc(
    async (command, args) => {
      if (command !== "get_scope_owner_facts")
        throw new Error(`Unexpected IPC: ${command}`);
      reads += 1;
      const path = String((args as { path: string }).path);
      await delay.get(path);
      if (state.fail) throw new Error("facts unavailable");
      // Svode's `file_not_found` arrives as its bare message.
      if (missing.has(path)) throw `File not found: ${path}`;
      return facts.get(path);
    },
    { shouldMockEvents: true },
  );
  const seen: {
    owner: ScopeOwnerRef | null;
    error: string | null;
    gone: boolean;
  }[] = [];
  let latest: ReturnType<typeof useScopeOwner> = {
    owner: null,
    error: null,
    gone: false,
    retry: () => {},
  };
  function Harness(props: {
    path: string;
    known: ScopeOwnerFacts | null;
    retainPrevious: boolean;
    structure?: ScopeOwnerStructure;
  }) {
    const result = useScopeOwner({
      target: {
        spaceId: "root",
        spacePath,
        projectPath: "/project",
        path: props.path,
      },
      known: props.known,
      retainPrevious: props.retainPrevious,
      structure: props.structure,
    });
    useEffect(() => {
      latest = result;
      seen.push({
        owner: result.owner,
        error: result.error,
        gone: result.gone,
      });
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    facts,
    delay,
    missing,
    seen,
    tick,
    set fail(value: boolean) {
      state.fail = value;
    },
    reads: () => reads,
    current: () => latest.owner,
    error: () => latest.error,
    gone: () => latest.gone,
    retry: () => latest.retry(),
    render: async (
      path: string,
      known: ScopeOwnerFacts | null,
      retainPrevious = false,
      structure?: ScopeOwnerStructure,
    ) => {
      await act(async () => {
        root.render(
          <Harness
            path={path}
            known={known}
            retainPrevious={retainPrevious}
            structure={structure}
          />,
        );
      });
    },
    settle: async () => {
      await act(async () => {
        await tick();
        await tick();
      });
    },
    emit: async (
      event: "file:created" | "file:changed" | "file:deleted",
      path: string,
    ) => {
      await act(async () => {
        await emitNativeEvent(event, { space: spacePath, path });
        await tick();
        await tick();
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
