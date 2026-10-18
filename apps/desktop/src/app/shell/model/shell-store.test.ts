import { expect, test } from "bun:test";
import { useShellStore } from "./shell-store";
import { createDefaultKnowledgeFilters } from "@/features/knowledge";

test("graph handoff transfers query, scope, and selection without replacing content state", () => {
  useShellStore.setState({
    mainSurface: "content",
    knowledgeGraphOpenRequest: null,
    nextKnowledgeGraphOpenRequestKey: 1,
  });

  useShellStore.getState().openGraphSurface({
    query: "architecture",
    scope: { kind: "space", spaceId: "child" },
    filters: createDefaultKnowledgeFilters(),
    selectedNodeId: "page:child:notes.md",
  });

  expect(useShellStore.getState().mainSurface).toBe("graph");
  expect(useShellStore.getState().knowledgeGraphOpenRequest).toEqual({
    query: "architecture",
    scope: { kind: "space", spaceId: "child" },
    filters: createDefaultKnowledgeFilters(),
    selectedNodeId: "page:child:notes.md",
    requestKey: 1,
  });

  useShellStore.getState().openContentSurface();
  expect(useShellStore.getState().mainSurface).toBe("content");
  expect(useShellStore.getState().knowledgeGraphOpenRequest?.query).toBe(
    "architecture",
  );
});

test("repository recovery opens the exact space settings Git destination", () => {
  useShellStore.getState().closeSettings();
  useShellStore.getState().openSpaceSettings("/project/spaces/docs", "git");
  expect(useShellStore.getState().settingsDestination).toEqual({
    scope: "project",
    section: "git",
    spacePath: "/project/spaces/docs",
  });
  useShellStore.getState().openAppSettings();
  expect(useShellStore.getState().settingsDestination).toEqual({
    scope: "app",
    section: "git-identity",
  });
  useShellStore.getState().closeSettings();
  expect(useShellStore.getState().settingsDestination).toBeNull();
});

test("global Variables opens the full settings catalog", () => {
  useShellStore.getState().openAppSettings("variables");
  expect(useShellStore.getState().settingsDestination).toEqual({
    scope: "app",
    section: "variables",
  });
  useShellStore.getState().closeSettings();
  expect(useShellStore.getState().settingsDestination).toBeNull();
});

test("a session is its own main area object and replaces the session peek", () => {
  const target = { sessionId: "codex:a", launchId: "launch-a" };
  useShellStore.getState().openContentSurface();

  useShellStore.getState().openSessionPeek(target);
  expect(useShellStore.getState().sessionPeekTarget).toEqual(target);
  expect(useShellStore.getState().mainSurface).toBe("content");

  useShellStore.getState().openSessionMainSurface(target);
  expect(useShellStore.getState().mainSurface).toBe("session");
  expect(useShellStore.getState().mainSessionTarget).toEqual(target);
  expect(useShellStore.getState().sessionPeekTarget).toBeNull();

  useShellStore.getState().openSessionPeek(target);
  useShellStore.getState().openContentSurface();
  expect(useShellStore.getState().mainSurface).toBe("content");
  expect(useShellStore.getState().mainSessionTarget).toBeNull();
  expect(useShellStore.getState().sessionPeekTarget).toBeNull();
});

test("closing the Graph returns to the object it was opened over", () => {
  const target = { sessionId: "codex:a", launchId: null };
  const graph = {
    query: "",
    scope: { kind: "project" as const },
    filters: createDefaultKnowledgeFilters(),
    selectedNodeId: null,
  };

  useShellStore.getState().openSessionMainSurface(target, { focus: false });
  expect(useShellStore.getState().mainSessionFocus).toBe(false);
  useShellStore.getState().openGraphSurface(graph);
  useShellStore.getState().closeGraphSurface();
  expect(useShellStore.getState().mainSurface).toBe("session");
  expect(useShellStore.getState().mainSessionTarget).toEqual(target);

  useShellStore.getState().openContentSurface();
  useShellStore.getState().openGraphSurface(graph);
  useShellStore.getState().closeGraphSurface();
  expect(useShellStore.getState().mainSurface).toBe("content");

  // Outside the Graph it changes nothing.
  useShellStore.getState().closeGraphSurface();
  expect(useShellStore.getState().mainSurface).toBe("content");
});

test("the main area and the peek follow a moved terminal in place; other openings stay", () => {
  const old = { sessionId: "claude:old", launchId: null };
  const moved = { sessionId: "claude:new", launchId: null };
  const other = { sessionId: "codex:other", launchId: null };
  const follow = (target: { sessionId: string; launchId: string | null }) =>
    target.sessionId === old.sessionId ? moved : null;

  useShellStore.getState().openSessionMainSurface(old);
  useShellStore.getState().openSessionPeek(other);
  const { mainSessionOpening, sessionPeekOpening } = useShellStore.getState();
  useShellStore.getState().followSessionTerminal(follow);
  let state = useShellStore.getState();
  expect(state.mainSessionTarget).toEqual(moved);
  expect(state.sessionPeekTarget).toEqual(other);
  // Following is no new opening: the surfaces keep their content.
  expect(state.mainSessionOpening).toBe(mainSessionOpening);
  expect(state.sessionPeekOpening).toBe(sessionPeekOpening);

  useShellStore.getState().openSessionPeek(old);
  useShellStore.getState().followSessionTerminal(follow);
  state = useShellStore.getState();
  expect(state.sessionPeekTarget).toEqual(moved);
  expect(state.sessionPeekOpening).toBe(sessionPeekOpening + 1);

  // Opening the same session again is a new opening.
  useShellStore.getState().openSessionMainSurface(moved);
  expect(useShellStore.getState().mainSessionOpening).toBe(
    mainSessionOpening + 1,
  );
  useShellStore.getState().openContentSurface();
});
