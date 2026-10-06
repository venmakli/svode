import { expect, test } from "bun:test";
import type { AgentSession } from "@/features/agent-sessions";
import type { NavigationResolvedItem } from "@/features/navigation";
import { homeProjectRows } from "./home-project-items-model";
import type { MainAreaObject } from "./main-area-object";

const RUNNING = {
  state: "running",
  source: "native_status_reader",
  confidence: "approximate",
} as AgentSession["status"];

function session(id: string, running = false) {
  return {
    id,
    source: "codex",
    title: id,
    status: running ? RUNNING : "idle",
  } as AgentSession;
}

function sessionItem(id: string): NavigationResolvedItem {
  return { key: { kind: "session", sessionId: id }, title: id };
}

function page(path: string): NavigationResolvedItem {
  return { key: { kind: "page", path }, title: path, available: true };
}

function labels(rows: ReturnType<typeof homeProjectRows>) {
  return rows.map((row) => {
    switch (row.kind) {
      case "active":
        return `active:${row.session.id}`;
      case "temporary":
        return `temporary:${row.temporary.item.title}`;
      default:
        return `${row.kind}:${row.item.title}`;
    }
  });
}

const mainPage: MainAreaObject = {
  kind: "artifact",
  item: { key: { kind: "page", path: "open.md" }, title: "open" },
};

test("pins come first, then active sessions, kept objects and the temporary row", () => {
  const rows = homeProjectRows({
    pinned: [page("roadmap.md"), sessionItem("codex:pinned")],
    kept: [page("plan.md"), sessionItem("codex:working")],
    activeSessions: [session("codex:working", true)],
    main: { object: mainPage, described: page("open.md") },
  });

  expect(labels(rows)).toEqual([
    "pinned:roadmap.md",
    "pinned:codex:pinned",
    "active:codex:working",
    "kept:plan.md",
    "temporary:open.md",
  ]);
});

test("an object shows once: a pinned active session and a kept main object", () => {
  const rows = homeProjectRows({
    pinned: [sessionItem("codex:pinned")],
    kept: [page("open.md")],
    activeSessions: [session("codex:pinned", true)],
    main: { object: mainPage, described: page("open.md") },
  });

  expect(labels(rows)).toEqual(["pinned:codex:pinned", "kept:open.md"]);
});

test("only the active project has a temporary row", () => {
  const inactive = homeProjectRows({
    pinned: [],
    kept: [page("plan.md")],
    activeSessions: [session("codex:working", true)],
    main: null,
  });

  expect(labels(inactive)).toEqual(["active:codex:working", "kept:plan.md"]);
});

test("an empty project has no rows", () => {
  expect(
    homeProjectRows({ pinned: [], kept: [], activeSessions: [], main: null }),
  ).toEqual([]);
});
