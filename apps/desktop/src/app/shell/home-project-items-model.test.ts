import { expect, test } from "bun:test";
import type { AgentSession } from "@/features/agent-sessions";
import type { NavigationResolvedItem } from "@/features/navigation";
import { homeProjectRows } from "./home-project-items-model";
import { composeNow } from "./now-model";

function page(path: string): NavigationResolvedItem {
  return { key: { kind: "page", path }, title: path, available: true };
}

test("pins come first, then Now in its order, each object once", () => {
  const working = {
    id: "codex:working",
    source: "codex",
    title: "Work",
    lastActivityAt: "2026-10-27T10:00:00Z",
  } as AgentSession;
  const pinned = [
    page("roadmap.md"),
    { key: { kind: "session", sessionId: "codex:working" }, title: "Work" },
  ] satisfies NavigationResolvedItem[];
  const now = composeNow({
    pinned,
    kept: [page("plan.md")],
    activeSessions: [working],
    sessions: [working],
    shown: [],
    mainObject: null,
    described: null,
  });

  expect(
    homeProjectRows(pinned, now).map((row) =>
      row.kind === "active"
        ? `active:${row.session.id}`
        : `${row.kind}:${row.kind === "temporary" ? row.temporary.item.title : row.item.title}`,
    ),
  ).toEqual(["pinned:roadmap.md", "pinned:Work", "kept:plan.md"]);
});

test("an empty project has no rows", () => {
  expect(homeProjectRows([], [])).toEqual([]);
});
