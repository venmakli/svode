import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  applyCollectionQuery,
  EMPTY_COLLECTION_QUERY,
} from "@/features/collection";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import { setLocale } from "@/paraglide/runtime";
import type { AgentSession } from "../model";
import { listedSession, listResult } from "../model/testing/catalog";
import {
  createAgentSessionsPresentationDescriptor,
  agentSessionsSourceProblem,
  toAgentSessionsPresentationState,
  type AgentSessionsPresentationActions,
} from "./sessions-presentation";

const agents = createAgentAdapterDictionary([
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
]);

const done = listedSession({
  id: "codex:done",
  launchId: "launch-review",
  title: "Refactor docs",
  lastActivityAt: "2026-09-29T12:00:00Z",
  resumeCommand: {
    display: "codex resume done",
    program: "codex",
    args: ["resume", "done"],
    cwd: "/project",
  },
});
const working = listedSession({
  id: "claude-code:working",
  launchId: "launch-sync",
  source: "claude-code",
  title: "Write tests",
  status: "active",
  lastActivityAt: "2026-09-29T09:00:00Z",
});
const waiting = listedSession({
  id: "codex:waiting",
  title: "Review plan",
  status: "active",
  activeFlags: ["waitingOnApproval"],
  lastActivityAt: "2026-09-29T08:00:00Z",
});
const withTerminal = listedSession({
  id: "codex:terminal",
  title: "Old session",
  lastActivityAt: "2026-09-28T08:00:00Z",
  runtime: {
    ptyId: "pty-1",
    live: true,
    lastOutputAt: "2026-09-29T13:00:00Z",
  },
});
const rows: AgentSession[] = [done, working, waiting, withTerminal];

function routineLink(
  launchId: string,
  name: string,
  definitionPresent: boolean,
): RoutineLaunchLink {
  return {
    launchId,
    routineId: `routine-${launchId}`,
    resolvedOwnerKind: "space",
    spaceId: "docs",
    ownerPath: ".",
    name,
    definitionPresent,
  };
}
const routines = new Map([
  ["launch-review", routineLink("launch-review", "Review", true)],
  ["launch-sync", routineLink("launch-sync", "Nightly sync", false)],
]);

function actions(
  overrides: Partial<AgentSessionsPresentationActions> = {},
): AgentSessionsPresentationActions {
  return {
    createState: { status: "idle" },
    onCreate: async () => undefined,
    terminalOf: (session) => session.runtime?.ptyId ?? null,
    onCloseTerminal: () => undefined,
    onCopyResumeCommand: () => undefined,
    onOpenExternalTerminal: () => undefined,
    routineOf: (session) =>
      (session.launchId && routines.get(session.launchId)) || null,
    onOpenRoutine: () => undefined,
    pinnedOf: () => null,
    pinPending: () => false,
    onTogglePin: () => undefined,
    keepable: () => false,
    onKeep: () => undefined,
    ...overrides,
  };
}

function descriptor() {
  return createAgentSessionsPresentationDescriptor({
    actions: actions(),
    agents,
    rows,
  });
}

function query(
  overrides: Partial<typeof EMPTY_COLLECTION_QUERY>,
): typeof EMPTY_COLLECTION_QUERY {
  return { ...EMPTY_COLLECTION_QUERY, ...overrides };
}

setLocale("en", { reload: false });

test("rows show the session sign, title, status, agent, routine and last activity", () => {
  const presentation = descriptor();

  expect(presentation.properties.map((property) => property.key)).toEqual([
    "agent",
    "status",
    "routine",
    "last-activity",
  ]);
  expect(presentation.layout.kind).toBe("list");
  expect(
    presentation.layout.kind === "list"
      ? presentation.layout.visibleProperties
      : null,
  ).toEqual(["status", "agent", "routine", "last-activity"]);
  const status = presentation.properties.find(
    (property) => property.key === "status",
  );
  expect(
    status?.semantics.kind === "standard"
      ? status.semantics.standard.options?.map((option) => option.name)
      : null,
  ).toEqual([
    "Waiting for approval",
    "Waiting for input",
    "Working",
    "Done",
    "Failed",
    "Stopped",
    "Unknown",
  ]);
  const agent = presentation.properties.find(
    (property) => property.key === "agent",
  );
  expect(agent?.getValue(working)).toBe("Claude Code");
  const routine = presentation.properties.find(
    (property) => property.key === "routine",
  );
  // A deleted definition keeps its last known name; other sessions stay empty.
  expect(routine?.getValue(done)).toBe("Review");
  expect(routine?.getValue(working)).toBe("Nightly sync");
  expect(routine?.getValue(waiting)).toBeNull();
  expect(
    routine?.semantics.kind === "standard"
      ? routine.semantics.standard.options?.map((option) => option.name)
      : null,
  ).toEqual(["Review", "Nightly sync"]);
});

test("filter, sort and search by routine", () => {
  const presentation = descriptor();
  const byRoutine = applyCollectionQuery({
    descriptor: presentation,
    query: query({
      filters: [{ propertyKey: "routine", operator: "eq", value: "Review" }],
    }),
    rows,
  });
  const sorted = applyCollectionQuery({
    descriptor: presentation,
    query: query({ sort: [{ propertyKey: "routine", direction: "asc" }] }),
    rows,
  });
  const searched = applyCollectionQuery({
    descriptor: presentation,
    query: query({ search: "nightly" }),
    rows,
  });

  expect(byRoutine.rows.map((row) => row.id)).toEqual(["codex:done"]);
  // A select sorts by option order, like every select property.
  expect(sorted.rows.slice(0, 2).map((row) => row.id)).toEqual([
    "codex:done",
    "claude-code:working",
  ]);
  expect(searched.rows.map((row) => row.id)).toEqual(["claude-code:working"]);
});

test("every status value is shown by the Status property, including Done", () => {
  const presentation = descriptor();
  const status = presentation.properties.find(
    (property) => property.key === "status",
  );
  const leading = (session: AgentSession) =>
    presentation.layout.kind === "list"
      ? renderToStaticMarkup(
          <>{presentation.layout.renderLeading?.(session)}</>,
        )
      : "";

  expect(status?.getValue(done)).toBe("Done");
  expect(status?.getValue(waiting)).toBe("Waiting for approval");
  // The leading sign is the same for every session: status is a property.
  expect(leading(done)).toBe(leading(waiting));
  expect(leading(withTerminal)).toBe(leading(done));
});

test("default order is waiting, then working, then last activity", () => {
  const ordered = applyCollectionQuery({
    descriptor: descriptor(),
    query: EMPTY_COLLECTION_QUERY,
    rows,
  });

  expect(ordered.rows.map((row) => row.id)).toEqual([
    "codex:waiting",
    "claude-code:working",
    "codex:terminal",
    "codex:done",
  ]);
});

test("filters, sorts and search use status, agent and last activity", () => {
  const presentation = descriptor();
  const byStatus = applyCollectionQuery({
    descriptor: presentation,
    query: query({
      filters: [{ propertyKey: "status", operator: "eq", value: "Working" }],
    }),
    rows,
  });
  const byAgent = applyCollectionQuery({
    descriptor: presentation,
    query: query({
      filters: [{ propertyKey: "agent", operator: "eq", value: "Codex" }],
      sort: [{ propertyKey: "last-activity", direction: "asc" }],
    }),
    rows,
  });
  const searched = applyCollectionQuery({
    descriptor: presentation,
    query: query({ search: "claude" }),
    rows,
  });
  const searchedStatus = applyCollectionQuery({
    descriptor: presentation,
    query: query({ search: "approval" }),
    rows,
  });

  expect(byStatus.rows.map((row) => row.id)).toEqual(["claude-code:working"]);
  // An open terminal counts its own activity, not the session log.
  expect(byAgent.rows.map((row) => row.id)).toEqual([
    "codex:waiting",
    "codex:done",
    "codex:terminal",
  ]);
  expect(searched.rows.map((row) => row.id)).toEqual(["claude-code:working"]);
  expect(searchedStatus.rows.map((row) => row.id)).toEqual(["codex:waiting"]);
});

test("row actions follow the session: close only an open terminal, copy and open only when available", () => {
  const calls: string[] = [];
  const presentation = createAgentSessionsPresentationDescriptor({
    actions: actions({
      onCloseTerminal: (session) => calls.push(`close:${session.id}`),
      onCopyResumeCommand: (session) => calls.push(`copy:${session.id}`),
      onOpenRoutine: (routine) => calls.push(`routine:${routine.routineId}`),
    }),
    agents,
    rows,
  });
  const visible = (session: AgentSession) =>
    (presentation.rowActions ?? [])
      .filter((action) => action.isVisible?.(session) ?? true)
      .map((action) => action.id);

  expect(visible(withTerminal)).toEqual(["close-terminal"]);
  expect(visible(done)).toEqual([
    "open-routine",
    "copy-resume-command",
    "open-external-terminal",
  ]);
  // A deleted routine shows its name without the way to it.
  expect(visible(working)).toEqual([]);
  for (const action of presentation.rowActions ?? []) {
    if (action.isVisible?.(withTerminal) ?? true) {
      void action.run(withTerminal);
    }
  }
  const openRoutine = presentation.rowActions?.find(
    (action) => action.id === "open-routine",
  );
  void openRoutine?.run(done);
  expect(calls).toEqual([
    "close:codex:terminal",
    "routine:routine-launch-review",
  ]);
});

test("pin and unpin follow the pin state of each row", () => {
  const toggled: string[] = [];
  const presentation = createAgentSessionsPresentationDescriptor({
    actions: actions({
      pinnedOf: (session) =>
        session === done ? true : session === working ? false : null,
      pinPending: (session) => session === working,
      onTogglePin: (session) => toggled.push(session.id),
    }),
    agents,
    rows,
  });
  const pin = presentation.rowActions?.find((action) => action.id === "pin");

  expect(pin?.isVisible?.(withTerminal)).toBe(false);
  expect(pin?.getLabel?.(done)).toBe("Unpin");
  expect(pin?.getLabel?.(working)).toBe("Pin");
  expect(pin?.getState(working)).toEqual({ status: "pending" });
  void pin?.run(done);
  expect(toggled).toEqual([done.id]);
});

test("keep in Now shows only for rows that are neither pinned nor kept", () => {
  const kept: string[] = [];
  const presentation = createAgentSessionsPresentationDescriptor({
    actions: actions({
      keepable: (session) => session === working,
      onKeep: (session) => kept.push(session.id),
    }),
    agents,
    rows,
  });
  const keep = presentation.rowActions?.find((action) => action.id === "keep");

  expect(keep?.label).toBe("Keep in Now");
  expect(keep?.isVisible?.(working)).toBe(true);
  expect(keep?.isVisible?.(done)).toBe(false);
  void keep?.run(working);
  expect(kept).toEqual([working.id]);
});

test("collection states: loading, blocking error, partial source and empty Space", () => {
  const recovery = {
    onRetry: () => undefined,
    onOpenSettings: () => undefined,
  };

  expect(
    toAgentSessionsPresentationState(
      { result: null, error: null, refreshing: false, rows: [] },
      agents,
      recovery,
    ).phase,
  ).toBe("initial");
  expect(
    toAgentSessionsPresentationState(
      { result: null, error: "boom", refreshing: false, rows: [] },
      agents,
      recovery,
    ).phase,
  ).toBe("blocking_error");
  expect(
    toAgentSessionsPresentationState(
      { result: listResult([]), error: null, refreshing: false, rows: [] },
      createAgentAdapterDictionary([], false),
      recovery,
    ).phase,
  ).toBe("initial");

  const partial = {
    ...listResult([done]),
    status: "partial" as const,
    sources: [
      {
        ...sourceReport("claude-code"),
        status: "unreadable" as const,
      },
      sourceReport("codex"),
    ],
  };
  const partialState = toAgentSessionsPresentationState(
    { result: partial, error: null, refreshing: false, rows: [done] },
    agents,
    recovery,
  );
  expect(partialState.phase).toBe("ready");
  if (partialState.phase !== "ready") return;
  expect(partialState.rows).toEqual([done]);
  expect(partialState.diagnostics).toEqual([]);
  expect(
    agentSessionsSourceProblem({ result: partial, error: null }, agents),
  ).toBe("Sessions of Claude Code could not be read.");
  expect(
    agentSessionsSourceProblem(
      { result: listResult([done]), error: null },
      agents,
    ),
  ).toBeNull();

  const refreshFailed = toAgentSessionsPresentationState(
    {
      result: listResult([done]),
      error: "offline",
      refreshing: false,
      rows: [done],
    },
    agents,
    recovery,
  );
  expect(refreshFailed.phase).toBe("ready");
  if (refreshFailed.phase !== "ready") return;
  expect(refreshFailed.rows).toEqual([done]);
  expect(
    agentSessionsSourceProblem(
      { result: listResult([done]), error: "offline" },
      agents,
    ),
  ).toBe("offline");
  expect(
    renderToStaticMarkup(<>{refreshFailed.sourceEmpty}</>).includes(
      "not shared through Git",
    ),
  ).toBe(true);
});

function sourceReport(source: "codex" | "claude-code") {
  return {
    source,
    status: "ok" as const,
    rootPath: `/home/${source}`,
    scannedAt: "2026-09-29T10:00:00Z",
    cacheHit: true,
    counts: {
      filesScanned: 0,
      recordsRead: 0,
      candidates: 0,
      returnedSessions: 0,
      unresolvedCandidates: 0,
      incompleteCandidates: 0,
      malformedLines: 0,
      sourceErrors: 0,
      hotFilesChecked: 0,
      hotFilesReparsed: 0,
    },
    diagnostics: [],
    truncatedDiagnostics: 0,
  };
}
