import { expect, test } from "bun:test";

import type {
  NavigationItemDisplay,
  NavigationResolvedItem,
} from "@/features/navigation";

import { applyNavigationSource } from "./navigation-item-source-model";

const daily: NavigationResolvedItem = {
  key: {
    kind: "routine",
    ownerKind: "project",
    ownerPath: ".",
    routineId: "daily",
  },
  title: "Daily",
};
const ann: NavigationResolvedItem = {
  key: { kind: "person", email: "ann@example.com" },
  title: "Ann",
};
const page: NavigationResolvedItem = {
  key: { kind: "page", path: "plan.md" },
  title: "Plan",
  available: true,
};

function source(
  entries: Array<[string, string]>,
  confirmsAbsence = true,
): { items: Map<string, NavigationItemDisplay>; confirmsAbsence: boolean } {
  return {
    items: new Map(entries.map(([id, title]) => [id, { title, icon: null }])),
    confirmsAbsence,
  };
}

test("a read source names its items and drops the ones it confirms gone", () => {
  const retitled = new Map<string, string>();
  const result = applyNavigationSource(
    [daily, ann, page],
    source([["daily", "Daily standup"]]),
    retitled,
  );
  expect([...result.displays.values()].map((display) => display.title)).toEqual(
    ["Daily standup"],
  );
  expect(result.retitles).toEqual([{ key: daily.key, title: "Daily standup" }]);
  // The person is not in this source's set; the page is not an item.
  expect(result.gone).toEqual([ann.key]);

  // The same new name is written once, until the snapshot takes it.
  const again = applyNavigationSource(
    [daily],
    source([["daily", "Daily standup"]]),
    retitled,
  );
  expect(again.retitles).toEqual([]);
  const settled = applyNavigationSource(
    [{ ...daily, title: "Daily standup" }],
    source([["daily", "Daily standup"]]),
    retitled,
  );
  expect(settled.retitles).toEqual([]);
});

test("a read that cannot tell a gone item from an unreadable one keeps it", () => {
  const result = applyNavigationSource([daily], source([], false), new Map());
  expect(result.gone).toEqual([]);
  expect(result.displays.size).toBe(0);
});
