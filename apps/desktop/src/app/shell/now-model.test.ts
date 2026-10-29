import { expect, test } from "bun:test";
import type { AgentSession } from "@/features/agent-sessions";
import {
  arrangeNowOrder,
  settleHiddenNowRows,
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
  sessions: [] as AgentSession[],
  shown: [] as NowOrderRow[],
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

/**
 * Now as a window shows it over time, each state after the previous one, as
 * `useNowOrder` settles hidden rows and arranges the rest; `hide` is the
 * close button of an active session's row, `keeps` the items the ended rows
 * shown last are kept by. The listed sessions default to the active ones.
 */
function window() {
  let shown: NowOrderRow[] = [];
  let hidden: NowOrderRow[] = [];
  let rows: NowRow[] = [];
  const show = (input: Partial<typeof none>) => {
    const composed = composeNow({
      ...none,
      sessions: input.activeSessions ?? [],
      ...input,
      shown,
    });
    const order = composed.map(nowOrderRow);
    const settled = settleHiddenNowRows(hidden, order);
    hidden = settled.marks;
    const visible = order.flatMap((_, index) =>
      settled.hidden[index] ? [] : [index],
    );
    const arranged = arrangeNowOrder(
      shown,
      visible.map((index) => order[index]),
    ).map((at) => visible[at]);
    shown = arranged.map((index) => order[index]);
    rows = arranged.map((index) => composed[index]);
    return rows.map(label);
  };
  const hide = (sessionId: string) => {
    const row = rows.find(
      (current) =>
        current.kind === "active" && current.session.id === sessionId,
    )!;
    hidden = [...hidden, nowOrderRow(row)];
  };
  const keeps = () => shown.flatMap((row) => (row.keep ? [row.keep] : []));
  return Object.assign(show, { hide, keeps });
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

test("a session in the main area that Now did not show active is temporary", () => {
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
  // Its work ends while the main area shows it: kept in its place.
  expect(
    show({
      activeSessions: [a, n],
      sessions: [t, a, n],
      mainObject: inMain(t),
    }),
  ).toEqual(["active:codex:a", "kept:codex:t", "active:codex:n"]);
  // The keep lands: still in place.
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
  // A session that is pinned leaves; the rest keep their order.
  expect(
    show({
      pinned: [sessionItem("codex:a")],
      kept: [page("k.md"), page("tree.md")],
      activeSessions: [n, a],
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

test("closing an active session of any source hides it while nothing new happens (DF-207 R2)", () => {
  const show = window();
  const terminal = { ptyId: "pty-free", live: true };
  const sessions = [
    // A free agent in a Svode terminal or a terminal panel tab.
    session("codex:free", { runtime: terminal }),
    // A working agent in a Svode terminal.
    session("codex:term", {
      status: RUNNING,
      runtime: { ptyId: "pty-term", live: true },
    }),
    // A turn of the ACP runtime, an external process, a Routine launch.
    session("qwen:acp", { status: RUNNING }),
    session("claude:external", {
      status: { ...RUNNING, source: "native_status_reader" },
    }),
    session("codex:launch:r1", {
      status: RUNNING,
      launchId: "r1",
      runtime: { provisional: true, live: true },
    }),
    // A pending new session.
    session("new-session:pty-new", {
      source: "unknown",
      runtime: { ptyId: "pty-new", live: true },
    }),
  ];
  show({ activeSessions: sessions });
  for (const current of sessions) show.hide(current.id);
  expect(show({ activeSessions: sessions })).toEqual([]);

  // Output, input, newer activity, a refreshed catalog and a turn going on.
  const later = "2026-10-27T15:00:00Z";
  const refreshed = sessions.map((current) => ({
    ...current,
    lastActivityAt: later,
    runtime: current.runtime && {
      ...current.runtime,
      lastOutputAt: later,
      lastInputAt: later,
    },
  }));
  expect(show({ activeSessions: refreshed })).toEqual([]);
  // The pending session hands its terminal to the canonical one.
  const canonical = session("codex:new", {
    runtime: { ptyId: "pty-new", live: true },
  });
  expect(
    show({ activeSessions: [...refreshed.slice(0, 5), canonical] }),
  ).toEqual([]);
});

test("a hidden session comes back last on a new turn, a request, the main area or a keep (R2)", () => {
  const show = window();
  const free = session("codex:free", {
    runtime: { ptyId: "pty-free", live: true },
  });
  const working = session("codex:working", { status: RUNNING });
  const other = session("codex:other", {
    runtime: { ptyId: "pty-other", live: true },
  });
  expect(show({ activeSessions: [free, working, other] })).toEqual([
    "active:codex:free",
    "active:codex:working",
    "active:codex:other",
  ]);
  show.hide("codex:free");
  show.hide("codex:working");
  expect(show({ activeSessions: [free, working, other] })).toEqual([
    "active:codex:other",
  ]);
  // The free agent starts a turn; the working one waits for the user.
  expect(
    show({
      activeSessions: [
        { ...free, status: RUNNING },
        { ...working, status: WAITING },
        other,
      ],
    }),
  ).toEqual([
    "active:codex:other",
    "active:codex:free",
    "active:codex:working",
  ]);

  // Opened in the main area, or kept by a message from a peek.
  show.hide("codex:free");
  show.hide("codex:working");
  expect(show({ activeSessions: [free, working, other] })).toEqual([
    "active:codex:other",
  ]);
  expect(
    show({ activeSessions: [free, working, other], mainObject: inMain(free) }),
  ).toEqual(["active:codex:other", "active:codex:free"]);
  expect(
    show({
      kept: [sessionItem("codex:working")],
      activeSessions: [free, working, other],
      mainObject: inMain(free),
    }),
  ).toEqual([
    "active:codex:other",
    "active:codex:free",
    "active:codex:working",
  ]);
});

test("a hidden kept session stays out once unkept, and leaving the active sessions forgets it (R2)", () => {
  const show = window();
  const kept = session("codex:kept", {
    status: RUNNING,
    runtime: { ptyId: "pty-kept", live: true },
  });
  expect(
    show({ kept: [sessionItem("codex:kept")], activeSessions: [kept] }),
  ).toEqual(["active:codex:kept"]);
  // The close button unkeeps it as it hides it.
  show.hide("codex:kept");
  expect(show({ activeSessions: [kept] })).toEqual([]);
  // Its terminal closes after the turn: no longer active, it leaves unkept.
  expect(
    show({ activeSessions: [], sessions: [{ ...kept, status: IDLE }] }),
  ).toEqual([]);
  expect(show.keeps()).toEqual([]);
  // A new terminal without a turn shows it again: it was forgotten.
  expect(
    show({
      activeSessions: [{ ...kept, status: IDLE }],
    }),
  ).toEqual(["active:codex:kept"]);
});

test("an active session of any source stays kept in its place once it ends (DF-210 R1)", () => {
  const show = window();
  const turn = session("qwen:turn", { status: RUNNING });
  const terminal = session("codex:terminal", {
    runtime: { ptyId: "pty-terminal", live: true },
  });
  const external = session("claude:external", { status: RUNNING });
  const other = session("codex:other", { status: RUNNING });
  const all = [turn, terminal, external, other];
  expect(show({ kept: [page("k.md")], activeSessions: all })).toEqual([
    "kept:k.md",
    "active:qwen:turn",
    "active:codex:terminal",
    "active:claude:external",
    "active:codex:other",
  ]);

  // The turn ends, the terminal closes, the external turn ends.
  const ended = [
    { ...turn, status: IDLE },
    { ...terminal, runtime: undefined },
    { ...external, status: IDLE },
  ];
  const listed = [...ended, other];
  const order = [
    "kept:k.md",
    "kept:qwen:turn",
    "kept:codex:terminal",
    "kept:claude:external",
    "active:codex:other",
  ];
  expect(
    show({ kept: [page("k.md")], activeSessions: [other], sessions: listed }),
  ).toEqual(order);
  expect(show.keeps()).toEqual(
    ended.map((current) => ({
      key: { kind: "session", sessionId: current.id },
      title: current.id,
    })),
  );
  // Until the keeps land the rows stay, then they show as kept items.
  expect(
    show({ kept: [page("k.md")], activeSessions: [other], sessions: listed }),
  ).toEqual(order);
  const keptNow = [
    page("k.md"),
    sessionItem("codex:terminal"),
    sessionItem("qwen:turn"),
    sessionItem("claude:external"),
  ];
  expect(
    show({ kept: keptNow, activeSessions: [other], sessions: listed }),
  ).toEqual(order);
  expect(show.keeps()).toEqual([]);
  // Closing a kept row that ended unkeeps it for good.
  expect(
    show({
      kept: keptNow.filter((item) => item.title !== "qwen:turn"),
      activeSessions: [other],
      sessions: listed,
    }),
  ).toEqual([
    "kept:k.md",
    "kept:codex:terminal",
    "kept:claude:external",
    "active:codex:other",
  ]);
  expect(show.keeps()).toEqual([]);
});

test("a session in the main area that ends is kept in its place, not temporary (R1)", () => {
  const show = window();
  const a = session("codex:a", { status: RUNNING });
  const free = session("codex:free", {
    runtime: { ptyId: "pty-free", live: true },
  });
  expect(show({ activeSessions: [free, a], mainObject: inMain(free) })).toEqual(
    ["active:codex:free", "active:codex:a"],
  );
  // Its terminal closes without a message.
  const closed = { ...free, runtime: undefined };
  expect(
    show({
      activeSessions: [a],
      sessions: [closed, a],
      mainObject: inMain(closed),
    }),
  ).toEqual(["kept:codex:free", "active:codex:a"]);
  expect(show.keeps()).toEqual([
    { key: { kind: "session", sessionId: "codex:free" }, title: "codex:free" },
  ]);
});

test("a hidden, pinned, pending or unlisted session that ends is not kept (R2)", () => {
  const show = window();
  const hidden = session("codex:hidden", { status: RUNNING });
  const pinned = session("codex:pinned", { status: RUNNING });
  const pending = session("new-session:pty-new", {
    source: "unknown",
    runtime: { ptyId: "pty-new", live: true },
  });
  const gone = session("codex:gone", { status: RUNNING });
  const other = session("codex:other", { status: RUNNING });
  show({
    pinned: [sessionItem("codex:pinned")],
    activeSessions: [hidden, pinned, pending, gone, other],
  });
  show.hide("codex:hidden");
  expect(
    show({
      pinned: [sessionItem("codex:pinned")],
      activeSessions: [hidden, pinned, pending, gone, other],
    }),
  ).toEqual([
    "active:new-session:pty-new",
    "active:codex:gone",
    "active:codex:other",
  ]);
  // Each ends; the pending one without a canonical record, the gone one is
  // no longer listed.
  expect(
    show({
      pinned: [sessionItem("codex:pinned")],
      activeSessions: [other],
      sessions: [
        { ...hidden, status: IDLE },
        { ...pinned, status: IDLE },
        { ...pending, runtime: undefined },
        other,
      ],
    }),
  ).toEqual(["active:codex:other"]);
  expect(show.keeps()).toEqual([]);
  // The hidden one stays out once a new turn of it ended too.
  expect(
    show({
      pinned: [sessionItem("codex:pinned")],
      activeSessions: [other],
      sessions: [{ ...hidden, status: IDLE }, other],
    }),
  ).toEqual(["active:codex:other"]);
});

test("a pending session that ends after its canonical record is kept by the canonical key (R2)", () => {
  const show = window();
  const pending = session("new-session:pty-1", {
    source: "unknown",
    runtime: { ptyId: "pty-1", live: true },
  });
  const other = session("codex:other", { status: RUNNING });
  show({ activeSessions: [pending, other] });
  const canonical = session("codex:new", {
    runtime: { ptyId: "pty-1", live: true },
  });
  expect(show({ activeSessions: [canonical, other] })).toEqual([
    "active:codex:new",
    "active:codex:other",
  ]);
  expect(
    show({
      activeSessions: [other],
      sessions: [{ ...canonical, runtime: undefined }, other],
    }),
  ).toEqual(["kept:codex:new", "active:codex:other"]);
  expect(show.keeps()).toEqual([
    { key: { kind: "session", sessionId: "codex:new" }, title: "codex:new" },
  ]);
});

test("a kept session that ends stays kept with no new keep (R1)", () => {
  const show = window();
  const a = session("codex:a", { status: RUNNING });
  const b = session("codex:b", { status: RUNNING });
  show({ kept: [sessionItem("codex:a")], activeSessions: [a, b] });
  expect(
    show({
      kept: [sessionItem("codex:a")],
      activeSessions: [b],
      sessions: [{ ...a, status: IDLE }, b],
    }),
  ).toEqual(["kept:codex:a", "active:codex:b"]);
  expect(show.keeps()).toEqual([]);
});

test("the next launch of a Routine takes the place of the row of its previous launch (DF-210 R4)", () => {
  const show = window();
  const launched = (id: string): NavigationResolvedItem => ({
    ...sessionItem(id),
    routine: { ownerKind: "project", ownerPath: ".", routineId: "daily" },
  });
  const first = session("codex:r1", { status: RUNNING });
  const other = session("codex:c", { status: RUNNING });
  const next = session("codex:r2", { status: RUNNING });
  expect(
    show({
      kept: [page("b.md"), launched("codex:r1")],
      activeSessions: [first],
    }),
  ).toEqual(["kept:b.md", "active:codex:r1"]);
  expect(
    show({
      kept: [page("b.md"), launched("codex:r1")],
      activeSessions: [other],
      sessions: [first, other],
    }),
  ).toEqual(["kept:b.md", "kept:codex:r1", "active:codex:c"]);
  // Desktop kept the next launch in place of the previous one.
  expect(
    show({
      kept: [page("b.md"), launched("codex:r2")],
      activeSessions: [other, next],
      sessions: [first, other, next],
    }),
  ).toEqual(["kept:b.md", "active:codex:r2", "active:codex:c"]);
  expect(show.keeps()).toEqual([]);
});
