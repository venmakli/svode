import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { draftScopeMark, sessionScopeMark, sessionTimeLabel } from "./format";
import { buildAgentSessionScopes, type AgentSession } from "../model";

const now = Date.parse("2026-07-04T14:00:00Z");

function session(lastActivityAt: string): AgentSession {
  return {
    id: "codex:test",
    source: "codex",
    sourceSessionId: "test",
    title: "Test session",
    titleSource: "session-id",
    status: {
      state: "idle",
      stopReason: "end_turn",
      source: "native_status_reader",
      confidence: "approximate",
    },
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/repo",
    lastActivityAt,
    capabilities: {
      canResume: true,
      canOpenInChat: false,
    },
  };
}

function isoBefore(ms: number): string {
  return new Date(now - ms).toISOString();
}

test("session time label stays compact for weeks, months, and years", async () => {
  const originalNow = Date.now;
  const originalLocale = getLocale();
  Date.now = () => now;

  try {
    await setLocale("en", { reload: false });

    expect(sessionTimeLabel(session(isoBefore(3 * 24 * 60 * 60_000)))).toBe(
      "3d",
    );
    expect(sessionTimeLabel(session(isoBefore(14 * 24 * 60 * 60_000)))).toBe(
      "2w",
    );
    expect(sessionTimeLabel(session(isoBefore(60 * 24 * 60 * 60_000)))).toBe(
      "2m",
    );
    expect(sessionTimeLabel(session(isoBefore(730 * 24 * 60 * 60_000)))).toBe(
      "2y",
    );
  } finally {
    Date.now = originalNow;
    await setLocale(originalLocale, { reload: false });
  }
});

test("session time label localizes compact units for Russian", async () => {
  const originalNow = Date.now;
  const originalLocale = getLocale();
  Date.now = () => now;

  try {
    await setLocale("ru", { reload: false });

    expect(sessionTimeLabel(session(isoBefore(10 * 60_000)))).toBe("10м");
    expect(sessionTimeLabel(session(isoBefore(3 * 60 * 60_000)))).toBe("3ч");
    expect(sessionTimeLabel(session(isoBefore(3 * 24 * 60 * 60_000)))).toBe(
      "3д",
    );
    expect(sessionTimeLabel(session(isoBefore(14 * 24 * 60 * 60_000)))).toBe(
      "2н",
    );
    expect(sessionTimeLabel(session(isoBefore(60 * 24 * 60 * 60_000)))).toBe(
      "2мес",
    );
    expect(sessionTimeLabel(session(isoBefore(730 * 24 * 60 * 60_000)))).toBe(
      "2г",
    );
  } finally {
    Date.now = originalNow;
    await setLocale(originalLocale, { reload: false });
  }
});

test("session time label follows turns, not an open terminal, and waiting shows how long (DF-216)", async () => {
  const originalNow = Date.now;
  const originalLocale = getLocale();
  Date.now = () => now;

  try {
    await setLocale("en", { reload: false });

    const withTerminal: AgentSession = {
      ...session(isoBefore(3 * 60 * 60_000)),
      runtime: {
        ptyId: "pty-1",
        live: true,
        lastOutputAt: isoBefore(0),
        lastInputAt: isoBefore(0),
      },
    };
    expect(sessionTimeLabel(withTerminal)).toBe("3h");

    const waiting: AgentSession = {
      ...withTerminal,
      status: {
        state: "requires_action",
        request: "permission",
        source: "native_status_reader",
        confidence: "approximate",
      },
      waitingSince: isoBefore(10 * 60_000),
    };
    expect(sessionTimeLabel(waiting)).toBe("10m");
  } finally {
    Date.now = originalNow;
    await setLocale(originalLocale, { reload: false });
  }
});

test("a session's scope mark has the Space's or project's emoji, otherwise its kind", () => {
  const scopes = buildAgentSessionScopes({
    activeRootIcon: "🚀",
    activeRootId: "root",
    activeRootName: "Astra",
    activeRootPath: "/repo",
    spaces: [
      {
        id: "ideas",
        name: "Ideas",
        icon: "💡",
        path: "/repo/ideas",
        status: "ready",
      },
      {
        id: "notes",
        name: "Notes",
        icon: "",
        path: "/repo/notes",
        status: "ready",
      },
    ],
  });
  const names = new Map([
    ["ideas", "Ideas"],
    ["notes", "Notes"],
  ]);
  const inSpace = (spaceId: string | undefined, spacePath: string) => ({
    ...session(isoBefore(0)),
    scopeKind: "space" as const,
    spaceId,
    spacePath,
  });

  expect(
    sessionScopeMark(session(isoBefore(0)), scopes, "Astra", names),
  ).toEqual({
    kind: "project",
    name: "Astra",
    icon: "🚀",
  });
  expect(
    sessionScopeMark(inSpace("ideas", "/repo/ideas"), scopes, "Astra", names),
  ).toEqual({ kind: "space", name: "Ideas", icon: "💡" });
  expect(
    sessionScopeMark(inSpace("notes", "/repo/notes"), scopes, "Astra", names),
  ).toEqual({ kind: "space", name: "Notes", icon: null });
  // A Space no longer in the list keeps its kind and the last path segment.
  expect(
    sessionScopeMark(
      inSpace(undefined, "/repo/old/drafts"),
      scopes,
      "Astra",
      names,
    ),
  ).toEqual({ kind: "space", name: "drafts", icon: null });
  expect(sessionScopeMark(session(isoBefore(0)), [], null, new Map())).toEqual({
    kind: "project",
    name: "repo",
    icon: null,
  });
});

test("a draft's scope mark is its choice, otherwise the kind by the project root", () => {
  const choices = [
    {
      path: "/repo/ideas",
      name: "Ideas",
      icon: "💡",
      kind: "space" as const,
      unavailable: null,
    },
  ];

  expect(draftScopeMark("/repo/ideas", choices, "/repo")).toEqual({
    kind: "space",
    name: "Ideas",
    icon: "💡",
  });
  expect(draftScopeMark("/repo/notes/", choices, "/repo")).toEqual({
    kind: "space",
    name: "notes",
    icon: null,
  });
  expect(draftScopeMark("/repo", [], "/repo")).toEqual({
    kind: "project",
    name: "repo",
    icon: null,
  });
});
