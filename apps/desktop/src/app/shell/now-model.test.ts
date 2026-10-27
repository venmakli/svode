import { expect, test } from "bun:test";
import type { AgentSession } from "@/features/agent-sessions";
import {
  arrangeNowOrder,
  type NavigationItem,
  type NavigationResolvedItem,
  type NowOrderRow,
} from "@/features/navigation";
import type { MainAreaObject } from "./main-area-object";
import { composeNow, nowOrderRow, type NowRow } from "./now-model";

const RUNNING = {
  state: "running",
  source: "native_status_reader",
  confidence: "approximate",
} as AgentSession["status"];
const WAITING = {
  state: "requires_action",
  request: "permission",
  source: "svode_runtime",
  confidence: "exact",
} as AgentSession["status"];
const IDLE = {
  state: "idle",
  stopReason: "end_turn",
  source: "svode_runtime",
  confidence: "exact",
} as AgentSession["status"];

function session(id: string, overrides: Partial<AgentSession> = {}) {
  return {
    id,
    source: "codex",
    title: id,
    status: IDLE,
    lastActivityAt: "2026-10-27T10:00:00Z",
    ...overrides,
  } as AgentSession;
}

function sessionItem(id: string): NavigationResolvedItem {
  return { key: { kind: "session", sessionId: id }, title: id };
}

function page(path: string): NavigationResolvedItem {
  return {
    key: { kind: "page", spaceId: "docs", path },
    title: path,
    available: true,
  };
}

function inMain(current: AgentSession): MainAreaObject {
  return {
    kind: "session",
    item: sessionItem(current.id),
    session: current,
    target: { sessionId: current.id, launchId: null },
  };
}

const none = {
  pinned: [] as NavigationItem[],
  kept: [] as NavigationResolvedItem[],
  activeSessions: [] as AgentSession[],
  mainObject: null as MainAreaObject | null,
  described: null as NavigationResolvedItem | null,
};

function label(row: NowRow) {
  switch (row.kind) {
    case "active":
      return `active:${row.session.id}`;
    case "kept":
      return `kept:${row.item.title}`;
    case "temporary":
      return `temporary:${row.temporary.item.title}`;
  }
}

/** Now as a window shows it over time: each state after the previous one. */
function window() {
  let shown: NowOrderRow[] = [];
  return (input: Partial<typeof none>) => {
    const rows = composeNow({ ...none, ...input });
    const order = arrangeNowOrder(shown, rows.map(nowOrderRow));
    shown = order.map((index) => nowOrderRow(rows[index]));
    return order.map((index) => label(rows[index]));
  };
}

test("each object shows once: kept first in keep order, then active sessions", () => {
  const working = session("codex:working", { status: RUNNING });
  const pinnedActive = session("codex:pinned", { status: RUNNING });
  const rows = composeNow({
    ...none,
    pinned: [sessionItem("codex:pinned")],
    kept: [
      sessionItem("codex:done"),
      sessionItem("codex:working"),
      page("a.md"),
    ],
    activeSessions: [working, pinnedActive],
  });

  expect(rows.map(label)).toEqual([
    "kept:codex:done",
    "active:codex:working",
    "kept:a.md",
  ]);
});

test("active sessions not kept follow the kept objects, earlier activity first", () => {
  const rows = composeNow({
    ...none,
    kept: [page("a.md")],
    activeSessions: [
      session("codex:late", { lastActivityAt: "2026-10-27T12:00:00Z" }),
      session("codex:early", { lastActivityAt: "2026-10-27T09:00:00Z" }),
    ],
    mainObject: {
      kind: "artifact",
      item: { key: page("open.md").key, title: "open" },
    },
    described: page("open.md"),
  });
  expect(rows.map(label)).toEqual([
    "kept:a.md",
    "active:codex:early",
    "active:codex:late",
    "temporary:open.md",
  ]);
});

test("the main area artifact is temporary until it is pinned or kept", () => {
  const object: MainAreaObject = {
    kind: "artifact",
    item: { key: { kind: "page", spaceId: "docs", path: "a.md" }, title: "a" },
  };
  const described = { ...page("a.md"), title: "Plan" };
  const temporary = (input: Partial<typeof none>) =>
    composeNow({ ...none, ...input }).find((row) => row.kind === "temporary");

  expect(temporary({ mainObject: object, described })).toEqual({
    kind: "temporary",
    temporary: { item: described, keepItem: described, session: null },
  });
  // Not confirmed by its source yet, or gone: no row.
  expect(temporary({ mainObject: object, described: null })).toBe(undefined);
  expect(
    temporary({ mainObject: object, described, kept: [page("a.md")] }),
  ).toBe(undefined);
  expect(
    temporary({
      mainObject: object,
      described,
      pinned: [
        {
          key: { kind: "collection", spaceId: "docs", path: "a.md" },
          title: "a",
        },
      ],
    }),
  ).toBe(undefined);
  // A Space main page is never temporary.
  expect(
    composeNow({
      ...none,
      mainObject: {
        kind: "space",
        item: { key: { kind: "space", spaceId: "docs" }, title: "Docs" },
      },
    }),
  ).toEqual([]);
});

test("a session in the main area is temporary once it stops being active", () => {
  const done = session("codex:done");
  expect(composeNow({ ...none, mainObject: inMain(done) })).toEqual([
    {
      kind: "temporary",
      temporary: {
        item: sessionItem("codex:done"),
        keepItem: { key: sessionItem("codex:done").key, title: "codex:done" },
        session: done,
      },
    },
  ]);

  const working = session("codex:done", { status: RUNNING });
  expect(
    composeNow({
      ...none,
      mainObject: inMain(working),
      activeSessions: [working],
    }).map(label),
  ).toEqual(["active:codex:done"]);
});

test("after a terminal moves to a new session, Now has one row for it and the previous one only where it is kept", () => {
  const previous = session("claude:old");
  const next = session("claude:new", {
    runtime: { ptyId: "pty-1", live: true },
  });
  // The main area followed the terminal; the new session's turn has ended.
  const moved = { ...none, activeSessions: [next], mainObject: inMain(next) };
  expect(composeNow(moved).map(label)).toEqual(["active:claude:new"]);
  // Kept and pinned rows of the previous session are not redirected.
  expect(
    composeNow({
      ...moved,
      kept: [{ ...sessionItem(previous.id), available: true }],
    }).map(label),
  ).toEqual(["kept:claude:old", "active:claude:new"]);
  expect(
    composeNow({ ...moved, pinned: [sessionItem(previous.id)] }).map(label),
  ).toEqual(["active:claude:new"]);
  // Once its terminal closes, the new session stays as the main area object.
  const closed = { ...next, runtime: undefined };
  expect(
    composeNow({ ...none, mainObject: inMain(closed) }).map(label),
  ).toEqual(["temporary:claude:new"]);
});

test("a status change or new activity does not move a row (DF-206 R3)", () => {
  const show = window();
  const a = session("codex:a", { status: RUNNING });
  const b = session("codex:b", { status: RUNNING });
  const c = session("codex:c", { runtime: { ptyId: "pty-c", live: true } });
  expect(show({ activeSessions: [a, b, c] })).toEqual([
    "active:codex:a",
    "active:codex:b",
    "active:codex:c",
  ]);
  // Waiting, an open terminal, the end of a turn and newer activity.
  const later = "2026-10-27T13:00:00Z";
  expect(
    show({
      activeSessions: [
        { ...c, status: WAITING, lastActivityAt: later },
        { ...b, runtime: { ptyId: "pty-b", live: true } },
        {
          ...a,
          status: IDLE,
          runtime: { ptyId: "pty-a", live: true },
        },
      ],
    }),
  ).toEqual(["active:codex:a", "active:codex:b", "active:codex:c"]);
});

test("a session kept by a message, its end and a new turn keep its place (R3)", () => {
  const show = window();
  const a = session("codex:a", { status: RUNNING });
  const b = session("codex:b", { status: RUNNING });
  expect(show({ kept: [page("k.md")], activeSessions: [a, b] })).toEqual([
    "kept:k.md",
    "active:codex:a",
    "active:codex:b",
  ]);
  // A message keeps `a`, its turn ends, then a new turn starts.
  expect(
    show({
      kept: [page("k.md"), sessionItem("codex:a")],
      activeSessions: [a, b],
    }),
  ).toEqual(["kept:k.md", "active:codex:a", "active:codex:b"]);
  expect(
    show({ kept: [page("k.md"), sessionItem("codex:a")], activeSessions: [b] }),
  ).toEqual(["kept:k.md", "kept:codex:a", "active:codex:b"]);
  expect(
    show({
      kept: [page("k.md"), sessionItem("codex:a")],
      activeSessions: [a, b],
    }),
  ).toEqual(["kept:k.md", "active:codex:a", "active:codex:b"]);
});

test("temporary, active and kept states of one row keep its place (R3)", () => {
  const show = window();
  const t = session("codex:t");
  const a = session("codex:a", { status: RUNNING });
  // The session in the main area is temporary, then starts working.
  expect(show({ activeSessions: [a], mainObject: inMain(t) })).toEqual([
    "active:codex:a",
    "temporary:codex:t",
  ]);
  const working = { ...t, status: RUNNING };
  const n = session("codex:n", { status: RUNNING });
  expect(
    show({ activeSessions: [working, a, n], mainObject: inMain(working) }),
  ).toEqual(["active:codex:a", "active:codex:t", "active:codex:n"]);
  // Its work ends while the main area shows it: temporary in its place.
  expect(show({ activeSessions: [a, n], mainObject: inMain(t) })).toEqual([
    "active:codex:a",
    "temporary:codex:t",
    "active:codex:n",
  ]);
  // Kept by a double click: still in place.
  expect(
    show({
      kept: [sessionItem("codex:t")],
      activeSessions: [a, n],
      mainObject: inMain(t),
    }),
  ).toEqual(["active:codex:a", "kept:codex:t", "active:codex:n"]);
});

test("a pending session keeps its place as the canonical one (R3)", () => {
  const show = window();
  const pending = session("new-session:pty-1", {
    source: "unknown",
    runtime: { ptyId: "pty-1", live: true },
  });
  const other = session("codex:other", { status: RUNNING });
  expect(show({ activeSessions: [pending, other] })).toEqual([
    "active:new-session:pty-1",
    "active:codex:other",
  ]);
  const canonical = session("codex:new", {
    status: RUNNING,
    runtime: { ptyId: "pty-1", live: true },
  });
  expect(show({ activeSessions: [other, canonical] })).toEqual([
    "active:codex:new",
    "active:codex:other",
  ]);
  // A provisional launch continues by its launch id.
  const provisional = session("codex:launch:l1", {
    launchId: "l1",
    runtime: { provisional: true, live: true },
  });
  expect(show({ activeSessions: [provisional, other, canonical] })).toEqual([
    "active:codex:new",
    "active:codex:other",
    "active:codex:launch:l1",
  ]);
  expect(
    show({
      activeSessions: [
        session("codex:l1", { launchId: "l1", status: RUNNING }),
        other,
        canonical,
      ],
    }),
  ).toEqual(["active:codex:new", "active:codex:other", "active:codex:l1"]);
});

test("new rows come last before the temporary row; a leaving row moves none (R2, R4)", () => {
  const show = window();
  const a = session("codex:a", { status: RUNNING });
  const mainObject: MainAreaObject = {
    kind: "artifact",
    item: { key: page("open.md").key, title: "open" },
  };
  const described = page("open.md");
  expect(
    show({ kept: [page("k.md")], activeSessions: [a], mainObject, described }),
  ).toEqual(["kept:k.md", "active:codex:a", "temporary:open.md"]);
  // A new session, then an object kept from the tree.
  const n = session("codex:n", { status: RUNNING });
  expect(
    show({
      kept: [page("k.md")],
      activeSessions: [n, a],
      mainObject,
      described,
    }),
  ).toEqual([
    "kept:k.md",
    "active:codex:a",
    "active:codex:n",
    "temporary:open.md",
  ]);
  expect(
    show({
      kept: [page("k.md"), page("tree.md")],
      activeSessions: [n, a],
      mainObject,
      described,
    }),
  ).toEqual([
    "kept:k.md",
    "active:codex:a",
    "active:codex:n",
    "kept:tree.md",
    "temporary:open.md",
  ]);
  // A session that stops being active leaves; the rest keep their order.
  expect(
    show({
      kept: [page("k.md"), page("tree.md")],
      activeSessions: [n],
      mainObject,
      described,
    }),
  ).toEqual([
    "kept:k.md",
    "active:codex:n",
    "kept:tree.md",
    "temporary:open.md",
  ]);
});
