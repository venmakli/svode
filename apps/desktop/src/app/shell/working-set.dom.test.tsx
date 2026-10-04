import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_WORKING_SET_DOM !== "1") {
  test("working set DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_WORKING_SET_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  interface Session {
    id: string;
    title: string;
    source: string;
  }
  interface Key {
    kind: string;
    sessionId?: string;
  }

  /** The catalogue as the read-model lists it. */
  let listed: Session[] = [];
  const catalogListeners = new Set<() => void>();
  function setListed(next: Session[]) {
    listed = next;
    for (const listener of catalogListeners) listener();
  }
  mock.module("@/features/agent-sessions", () => ({
    agentSessionForNavigationKey: () => null,
    pinnableAgentSessionItem: (session: Session | null) =>
      session
        ? { key: { kind: "session", sessionId: session.id }, title: session.title }
        : null,
    useActiveAgentSessions: () => [],
    useListedAgentSessions: () =>
      useSyncExternalStore(
        (listener) => {
          catalogListeners.add(listener);
          return () => catalogListeners.delete(listener);
        },
        () => listed,
      ),
  }));

  const kept: { key: Key; title: string }[] = [];
  let pinned: { key: Key; title: string }[] = [];
  const editListeners = new Set<(edit: unknown) => void>();
  const keyId = (key: Key) => JSON.stringify([key.kind, key.sessionId]);
  mock.module("@/features/navigation", () => ({
    artifactNavigationKey: () => ({ kind: "page" }),
    getNavigationState: () => ({
      pinned,
      kept,
      pendingKeyIds: new Set<string>(),
      keep: async (item: { key: Key; title: string }) => {
        kept.push(item);
      },
    }),
    navigationKeyId: keyId,
    subscribeUserEdits: (listener: (edit: unknown) => void) => {
      editListeners.add(listener);
      return () => editListeners.delete(listener);
    },
  }));
  mock.module("@/features/artifact", () => ({
    closeActiveContent: () => {},
    prepareActiveContentDeactivation: async () => "ready",
  }));
  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: { activeRootId: string }) => unknown) =>
      selector({ activeRootId: "root" }),
  }));
  mock.module("./main-area-object", () => ({ useMainAreaObject: () => null }));
  mock.module("./now-model", () => ({ isSessionKey: () => false }));
  mock.module("./model", () => ({ useShellStore: () => null }));

  const { useKeepEditedObjects } = await import("./working-set");
  function Host() {
    useKeepEditedObjects();
    return null;
  }
  const root = createRoot(document.getElementById("app")!);
  await act(async () => root.render(<Host />));

  const message = async (sessionId: string) => {
    await act(async () => {
      for (const listener of editListeners) listener({ kind: "message", sessionId });
    });
  };
  const keptIds = () => kept.map((item) => item.key.sessionId);

  test("an accepted message keeps a listed session in Now", async () => {
    await act(async () =>
      setListed([{ id: "codex:a", title: "A", source: "codex" }]),
    );
    await message("codex:a");
    expect(keptIds()).toEqual(["codex:a"]);
    expect(kept[0].title).toBe("A");
  });

  test("a new session is kept once the catalogue lists it", async () => {
    kept.length = 0;
    await message("codex:new");
    expect(keptIds()).toEqual([]);
    await act(async () =>
      setListed([...listed, { id: "codex:new", title: "New", source: "codex" }]),
    );
    expect(keptIds()).toEqual(["codex:new"]);
    await act(async () => setListed([...listed]));
    expect(keptIds()).toEqual(["codex:new"]);
  });

  test("a pinned or kept session does not change", async () => {
    kept.length = 0;
    pinned = [{ key: { kind: "session", sessionId: "codex:a" }, title: "A" }];
    await message("codex:a");
    expect(keptIds()).toEqual([]);
    pinned = [];
    kept.push({ key: { kind: "session", sessionId: "codex:a" }, title: "A" });
    await message("codex:a");
    expect(keptIds()).toEqual(["codex:a"]);
  });

  test("an edit without a main area artifact keeps nothing", async () => {
    kept.length = 0;
    await act(async () => {
      for (const listener of editListeners) listener({ kind: "edit" });
    });
    expect(keptIds()).toEqual([]);
  });
}
