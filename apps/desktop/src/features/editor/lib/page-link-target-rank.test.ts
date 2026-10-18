import { expect, test } from "bun:test";

import {
  PAGE_LINK_NO_MATCH,
  pageLinkMatchLevel,
  pageNameKey,
  rankPageLinkTargets,
} from "./page-link-target-rank";

test("the name key ignores the case of any letter and Unicode forms", () => {
  expect(pageNameKey("План")).toBe(pageNameKey("план"));
  expect(pageNameKey("ПЛАН")).toBe(pageNameKey("план"));
  expect(pageNameKey("Ｐｌａｎ")).toBe(pageNameKey("plan"));
  expect(pageNameKey("Straße")).toBe(pageNameKey("STRASSE"));
  expect(pageNameKey("  Plan \t A ")).toBe("plan a");
});

test("match levels go from the equal title down to the path only", () => {
  const key = pageNameKey("plan");
  expect(pageLinkMatchLevel({ title: "Plan", path: "x.md" }, key)).toBe(0);
  expect(pageLinkMatchLevel({ title: "Plan A", path: "x.md" }, key)).toBe(1);
  expect(pageLinkMatchLevel({ title: "My plan", path: "x.md" }, key)).toBe(2);
  expect(pageLinkMatchLevel({ title: "Goals", path: "plans/g.md" }, key)).toBe(
    3,
  );
  expect(pageLinkMatchLevel({ title: "Goals", path: "g.md" }, key)).toBe(
    PAGE_LINK_NO_MATCH,
  );
  expect(
    pageLinkMatchLevel({ title: "План", path: "plan.md" }, pageNameKey("ПЛАН")),
  ).toBe(0);
});

test("ranking puts more exact matches first and keeps order within a level", () => {
  const targets = [
    { title: "Goals", path: "g.md" },
    { title: "Plan A", path: "a.md" },
    { title: "Plans", path: "plans/README.md" },
    { title: "Goals", path: "plan/goals.md" },
    { title: "My plan", path: "m.md" },
    { title: "plan", path: "plan.md" },
  ];
  expect(
    rankPageLinkTargets(targets, pageNameKey("Plan")).map((t) => t.path),
  ).toEqual([
    "plan.md",
    "a.md",
    "plans/README.md",
    "m.md",
    "plan/goals.md",
    "g.md",
  ]);
  expect(rankPageLinkTargets(targets, "")).toBe(targets);
});
