import { expect, test } from "bun:test";
import type { AgentSession } from "@/features/agent-sessions";
import type {
  NavigationItem,
  NavigationResolvedItem,
} from "@/features/navigation";
import type { MainAreaObject } from "./main-area-object";
import { composeNow } from "./now-model";

function session(id: string, overrides: Partial<AgentSession> = {}) {
  return {
    id,
    source: "codex",
    title: id,
    status: "idle",
    ...overrides,
  } as AgentSession;
}

function sessionItem(id: string): NavigationItem {
  return { key: { kind: "session", sessionId: id }, title: id };
}

function page(path: string): NavigationResolvedItem {
  return {
    key: { kind: "page", spaceId: "docs", path },
    title: path,
    available: true,
  };
}

const none = {
  pinned: [],
  kept: [],
  activeSessions: [],
  mainObject: null,
  described: null,
};

test("each object shows once: pinned first, then active, then kept", () => {
  const working = session("codex:working", {
    status: {
      state: "running",
      source: "native_status_reader",
      confidence: "approximate",
    },
  });
  const pinnedActive = session("codex:pinned", {
    status: {
      state: "running",
      source: "native_status_reader",
      confidence: "approximate",
    },
  });
  const now = composeNow({
    ...none,
    pinned: [sessionItem("codex:pinned")],
    kept: [
      sessionItem("codex:working"),
      sessionItem("codex:done"),
      page("a.md"),
    ],
    activeSessions: [working, pinnedActive],
  });

  expect(now.active.map((item) => item.id)).toEqual(["codex:working"]);
  expect(now.kept.map((item) => item.title)).toEqual(["codex:done", "a.md"]);
});

test("the main area artifact is temporary until it is pinned or kept", () => {
  const object: MainAreaObject = {
    kind: "artifact",
    item: { key: { kind: "page", spaceId: "docs", path: "a.md" }, title: "a" },
  };
  const described = { ...page("a.md"), title: "Plan" };

  expect(
    composeNow({ ...none, mainObject: object, described }).temporary,
  ).toEqual({ item: described, keepItem: described });
  // Not confirmed by its source yet, or gone: no row.
  expect(
    composeNow({ ...none, mainObject: object, described: null }).temporary,
  ).toBeNull();
  expect(
    composeNow({ ...none, mainObject: object, described, kept: [page("a.md")] })
      .temporary,
  ).toBeNull();
  expect(
    composeNow({
      ...none,
      mainObject: object,
      described,
      pinned: [
        {
          key: { kind: "collection", spaceId: "docs", path: "a.md" },
          title: "a",
        },
      ],
    }).temporary,
  ).toBeNull();
});

test("a Space main page is never temporary", () => {
  const object: MainAreaObject = {
    kind: "space",
    item: { key: { kind: "space", spaceId: "docs" }, title: "Docs" },
  };
  expect(composeNow({ ...none, mainObject: object }).temporary).toBeNull();
});

test("a session in the main area is temporary once it stops being active", () => {
  const done = session("codex:done");
  const object = (current: AgentSession): MainAreaObject => ({
    kind: "session",
    item: sessionItem(current.id),
    session: current,
    target: { sessionId: current.id, launchId: null },
  });

  expect(composeNow({ ...none, mainObject: object(done) }).temporary).toEqual({
    item: sessionItem("codex:done"),
    keepItem: sessionItem("codex:done"),
  });

  const working = session("codex:done", {
    status: {
      state: "running",
      source: "native_status_reader",
      confidence: "approximate",
    },
  });
  expect(
    composeNow({
      ...none,
      mainObject: object(working),
      activeSessions: [working],
    }).temporary,
  ).toBeNull();
});

test("after a terminal moves to a new session, Now has one row for it and the previous one only where it is kept", () => {
  const previous = session("claude:old");
  const next = session("claude:new", {
    runtime: { ptyId: "pty-1", live: true },
  });
  // The main area followed the terminal; the new session's turn has ended.
  const mainObject: MainAreaObject = {
    kind: "session",
    item: sessionItem(next.id),
    session: next,
    target: { sessionId: next.id, launchId: null },
  };
  const moved = { ...none, activeSessions: [next], mainObject };

  const now = composeNow(moved);
  expect(now.active.map((item) => item.id)).toEqual(["claude:new"]);
  expect(now.kept).toEqual([]);
  expect(now.temporary).toBeNull();

  // Kept and pinned rows of the previous session are not redirected.
  const kept = composeNow({
    ...moved,
    kept: [{ ...sessionItem(previous.id), available: true }],
  });
  expect(kept.kept.map((item) => item.key)).toEqual([
    { kind: "session", sessionId: "claude:old" },
  ]);
  expect(
    composeNow({ ...moved, pinned: [sessionItem(previous.id)] }).active.map(
      (item) => item.id,
    ),
  ).toEqual(["claude:new"]);

  // Once its terminal closes, the new session stays as the main area object.
  const closed = { ...next, runtime: undefined };
  expect(
    composeNow({
      ...none,
      mainObject: { ...mainObject, session: closed },
    }).temporary?.item.key,
  ).toEqual({ kind: "session", sessionId: "claude:new" });
});
