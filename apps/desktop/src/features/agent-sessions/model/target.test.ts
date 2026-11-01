import { expect, test } from "bun:test";
import { resolveAgentSessionId } from "./target";
import { listedSession } from "./testing/catalog";

test("a listed session resolves to itself", () => {
  const sessions = [listedSession({ id: "codex:a", launchId: "launch-a" })];
  expect(
    resolveAgentSessionId(
      { sessionId: "codex:a", launchId: "launch-a" },
      sessions,
      {},
    ),
  ).toBe("codex:a");
});

test("a pending terminal follows the CLI session matched to its pty", () => {
  const sessions = [listedSession({ id: "codex:started" })];
  expect(
    resolveAgentSessionId(
      { sessionId: "new-session:pty-1", launchId: null },
      sessions,
      { "new-session:pty-1": "codex:started" },
    ),
  ).toBe("codex:started");
});

test("a target the catalog does not list follows the session of its launch id", () => {
  const canonical = listedSession({ id: "codex:real", launchId: "launch-a" });
  const target = { sessionId: "codex:launch-a", launchId: "launch-a" };

  expect(resolveAgentSessionId(target, [], {})).toBe("codex:launch-a");
  expect(resolveAgentSessionId(target, [canonical], {})).toBe("codex:real");
});

test("an unknown target keeps its own id", () => {
  expect(
    resolveAgentSessionId({ sessionId: "codex:gone", launchId: null }, [], {}),
  ).toBe("codex:gone");
});

test("a target saved with another link of a conversation resolves to its record", () => {
  const sessions = [
    listedSession({ id: "hermes:root", aliasIds: ["hermes:tip"] }),
  ];
  expect(
    resolveAgentSessionId(
      { sessionId: "hermes:tip", launchId: null },
      sessions,
      {},
    ),
  ).toBe("hermes:root");
});
