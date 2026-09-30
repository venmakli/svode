import { expect, test } from "bun:test";
import { newSessionScopeChoices, resolveNewSessionTarget } from "./new-session";
import type { AgentSessionScopeGroup } from "./types";

const scope = (
  kind: AgentSessionScopeGroup["kind"],
  scopeId: string,
  status: AgentSessionScopeGroup["status"] = "ready",
): AgentSessionScopeGroup => ({
  id: `space:${scopeId}`,
  kind,
  scopeId,
  name: `${scopeId} name`,
  icon: null,
  path: `/project/${scopeId}`,
  status,
});

const root = scope("project", "root");
const docs = scope("space", "docs");
const lost = scope("space", "lost", "missing");
const bad = scope("space", "bad", "broken");
const scopes = [root, docs, lost, bad];

test("the root and a ready Space are targets", () => {
  expect(resolveNewSessionTarget(scopes, { spaceId: null })).toEqual({
    status: "ready",
    scope: root,
  });
  expect(resolveNewSessionTarget(scopes, { spaceId: "docs" })).toEqual({
    status: "ready",
    scope: docs,
  });
});

test("an unavailable Space names why instead of falling back to the root", () => {
  expect(resolveNewSessionTarget(scopes, { spaceId: "lost" })).toEqual({
    status: "missing",
    name: "lost name",
  });
  expect(resolveNewSessionTarget(scopes, { spaceId: "bad" })).toEqual({
    status: "broken",
    name: "bad name",
  });
  expect(resolveNewSessionTarget(scopes, { spaceId: "gone" })).toEqual({
    status: "missing",
    name: "gone",
  });
  expect(resolveNewSessionTarget(scopes, null)).toEqual({ status: "unknown" });
});

test("the current Space is the first choice", () => {
  expect(newSessionScopeChoices(scopes, docs)).toEqual([docs, root, lost, bad]);
  expect(newSessionScopeChoices(scopes, null)).toEqual(scopes);
});
