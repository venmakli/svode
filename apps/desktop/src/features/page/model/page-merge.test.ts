import { expect, test } from "bun:test";

import {
  acceptPageMerge,
  decidePageMergeProperty,
  getPageMergeState,
  movePageMerge,
  pageMergeDecided,
  setPageMerge,
  setPageMergeWrite,
  subscribePageMergeDecided,
  type PageMerge,
} from "./page-merge";
import { pageWithMerge } from "./page-merge-view";
import type { Page } from "./types";

const SPACE = "/space";
const OWNER = {
  key: "owner",
  base: "Ann",
  ours: "Ann",
  theirs: "Bob",
  disputed: false,
  merged: "Bob",
};
const MERGE: PageMerge = {
  type: "merged",
  body: "Text\n",
  properties: [
    {
      key: "title",
      base: "Plan",
      ours: "Plan",
      theirs: "Plan",
      disputed: false,
      merged: "Plan",
    },
    {
      key: "status",
      base: "a",
      ours: "b",
      theirs: "c",
      disputed: true,
      merged: undefined,
    },
    OWNER,
  ],
};

test("the Page is decided once every disputed property has a decision, and «Принять» with none disputed", () => {
  setPageMerge(SPACE, "a.md", MERGE);
  expect(pageMergeDecided(getPageMergeState(SPACE, "a.md"))).toBe(false);
  decidePageMergeProperty(SPACE, "a.md", "status", { type: "ours" });
  expect(pageMergeDecided(getPageMergeState(SPACE, "a.md"))).toBe(true);
  decidePageMergeProperty(SPACE, "a.md", "status", null);
  expect(pageMergeDecided(getPageMergeState(SPACE, "a.md"))).toBe(false);

  setPageMerge(SPACE, "b.md", {
    type: "merged",
    body: "",
    properties: [OWNER],
  });
  expect(pageMergeDecided(getPageMergeState(SPACE, "b.md"))).toBe(false);
  acceptPageMerge(SPACE, "b.md", true);
  expect(pageMergeDecided(getPageMergeState(SPACE, "b.md"))).toBe(true);

  setPageMerge(SPACE, "c.md", {
    type: "unavailable",
    reason: { type: "missing_stage" },
  });
  acceptPageMerge(SPACE, "c.md", true);
  expect(pageMergeDecided(getPageMergeState(SPACE, "c.md"))).toBe(false);
  for (const path of ["a.md", "b.md", "c.md"]) setPageMerge(SPACE, path, null);
});

test("a change of the decisions that leaves the Page decided asks for its write; a write state does not", () => {
  setPageMerge(SPACE, "a.md", MERGE);
  let calls = 0;
  const stop = subscribePageMergeDecided(SPACE, "a.md", () => (calls += 1));
  decidePageMergeProperty(SPACE, "a.md", "status", { type: "ours" });
  expect(calls).toBe(1);
  setPageMergeWrite(SPACE, "a.md", { status: "writing" });
  expect(calls).toBe(1);
  decidePageMergeProperty(SPACE, "a.md", "status", {
    type: "value",
    value: "d",
  });
  expect(calls).toBe(2);
  decidePageMergeProperty(SPACE, "a.md", "status", null);
  expect(calls).toBe(2);
  // Another Page does not ask.
  setPageMerge(SPACE, "other.md", MERGE);
  decidePageMergeProperty(SPACE, "other.md", "status", { type: "ours" });
  expect(calls).toBe(2);
  stop();
  setPageMerge(SPACE, "a.md", null);
  setPageMerge(SPACE, "other.md", null);
});

test("the merge follows its Page to a new path with its decisions", () => {
  setPageMerge(SPACE, "a.md", MERGE);
  decidePageMergeProperty(SPACE, "a.md", "status", { type: "theirs" });
  movePageMerge(SPACE, "a.md", "b.md");
  expect(getPageMergeState(SPACE, "a.md")).toBe(null);
  expect(getPageMergeState(SPACE, "b.md")?.decisions).toEqual({
    status: { type: "theirs" },
  });
  setPageMerge(SPACE, "b.md", null);
});

test("the properties read as the merged values and the decided values", () => {
  setPageMerge(SPACE, "a.md", MERGE);
  const page: Page = {
    path: "a.md",
    body: "",
    meta: { title: "a", icon: null, created: "", updated: "", extra: {} },
  };
  const before = pageWithMerge(page, getPageMergeState(SPACE, "a.md")!);
  expect(before.meta.title).toBe("Plan");
  expect(before.meta.extra).toEqual({ owner: "Bob" });
  decidePageMergeProperty(SPACE, "a.md", "status", { type: "theirs" });
  expect(
    pageWithMerge(page, getPageMergeState(SPACE, "a.md")!).meta.extra,
  ).toEqual({ status: "c", owner: "Bob" });
  setPageMerge(SPACE, "a.md", null);
});
