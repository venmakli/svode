import { expect, test } from "bun:test";
import {
  agentSessionTerminalFollow,
  agentSessionTerminalMoves,
  type AgentSessionTerminalFollowState,
} from "./terminal-follow";
import { listResult, listedSession } from "./testing/catalog";
import type { AgentSession } from "./types";

const live = (ptyId: string) => ({ ptyId, live: true });

function catalogState(
  sessions: AgentSession[],
  pendingHandoffs: Record<string, string> = {},
): AgentSessionTerminalFollowState {
  return { result: listResult(sessions), sessions, pendingHandoffs };
}

test("a live terminal the read-model lists at another session moves to it", () => {
  const before = [
    listedSession({ id: "claude:old", runtime: live("pty-1") }),
    listedSession({ id: "claude:other", runtime: live("pty-2") }),
  ];
  const after = [
    listedSession({ id: "claude:old" }),
    listedSession({ id: "claude:new", runtime: live("pty-1") }),
    listedSession({ id: "claude:other", runtime: live("pty-2") }),
  ];

  const moves = agentSessionTerminalMoves(before, after);
  expect([...moves].map(([from, to]) => [from, to.id])).toEqual([
    ["claude:old", "claude:new"],
  ]);
});

test("a terminal that stays, ends or becomes canonical is no move", () => {
  const session = listedSession({ id: "claude:a", runtime: live("pty-1") });
  expect(agentSessionTerminalMoves([session], [session]).size).toBe(0);
  expect(
    agentSessionTerminalMoves([session], [{ ...session, runtime: undefined }])
      .size,
  ).toBe(0);
  // The canonical record of a provisional launch carries its launch id.
  const provisional = listedSession({
    id: "codex:launch-a",
    launchId: "launch-a",
    runtime: { ...live("pty-2"), provisional: true },
  });
  const canonical = listedSession({
    id: "codex:real",
    launchId: "launch-a",
    runtime: live("pty-2"),
  });
  expect(agentSessionTerminalMoves([provisional], [canonical]).size).toBe(0);
  // Another link of the same conversation is the same session.
  const chain = listedSession({
    id: "hermes:root",
    aliasIds: ["hermes:a"],
    runtime: live("pty-3"),
  });
  expect(
    agentSessionTerminalMoves(
      [listedSession({ id: "hermes:a", runtime: live("pty-3") })],
      [chain],
    ).size,
  ).toBe(0);
});

test("a surface that showed the session with its terminal follows it; others stay", () => {
  const previous = catalogState(
    [
      listedSession({ id: "claude:old", runtime: live("pty-1") }),
      listedSession({ id: "claude:chat" }),
    ],
    { "new-session:pty-1": "claude:old" },
  );
  const next = catalogState([
    listedSession({ id: "claude:old" }),
    listedSession({ id: "claude:new", runtime: live("pty-1") }),
    listedSession({ id: "claude:chat" }),
  ]);

  const follow = agentSessionTerminalFollow(previous, next)!;
  const toNew = { sessionId: "claude:new", launchId: null };
  expect(follow({ sessionId: "claude:old", launchId: null })).toEqual(toNew);
  // A new-session terminal is addressed by its pending id until then.
  expect(follow({ sessionId: "new-session:pty-1", launchId: null })).toEqual(
    toNew,
  );
  expect(follow({ sessionId: "claude:chat", launchId: null })).toBeNull();

  // The previous session opened after the move has no terminal to follow.
  const later = catalogState(next.sessions);
  expect(agentSessionTerminalFollow(next, later)).toBeNull();
});

test("a terminal follows each further move of its agent", () => {
  const first = catalogState([
    listedSession({ id: "claude:a", runtime: live("pty-1") }),
  ]);
  const second = catalogState([
    listedSession({ id: "claude:a" }),
    listedSession({ id: "claude:b", runtime: live("pty-1") }),
  ]);
  const third = catalogState([
    listedSession({ id: "claude:a", runtime: live("pty-1") }),
    listedSession({ id: "claude:b" }),
  ]);

  const target = agentSessionTerminalFollow(first, second)!({
    sessionId: "claude:a",
    launchId: null,
  })!;
  expect(target.sessionId).toBe("claude:b");
  expect(agentSessionTerminalFollow(second, third)!(target)).toEqual({
    sessionId: "claude:a",
    launchId: null,
  });
});
