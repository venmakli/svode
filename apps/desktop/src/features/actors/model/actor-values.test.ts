import { expect, test } from "bun:test";

import {
  actorActivityEndDate,
  actorInitials,
  buildActorHeatmapCells,
  compareActorsByDefault,
  defaultActorActivityYear,
  mergeActorActivityPage,
  visibleActorAliases,
} from "./actor-values";
import type { ActorActivitySnapshot, ActorCatalogRow } from "./types";

function actor(
  input: Partial<ActorCatalogRow> &
    Pick<ActorCatalogRow, "canonicalEmail" | "displayName">,
): ActorCatalogRow {
  return {
    aliases: [],
    availableYears: [],
    commitCount: 0,
    contribution: "no_commits",
    lastActivityDate: null,
    lastCommitAt: null,
    sources: [],
    ...input,
  };
}

test("default actor ordering keeps empty activity last and uses name then email", () => {
  const rows = [
    actor({ canonicalEmail: "z@test", displayName: "Zed" }),
    actor({
      canonicalEmail: "b@test",
      displayName: "Ada",
      lastCommitAt: 10,
    }),
    actor({
      canonicalEmail: "a@test",
      displayName: "Ada",
      lastCommitAt: 10,
    }),
    actor({
      canonicalEmail: "new@test",
      displayName: "Newest",
      lastCommitAt: 20,
    }),
  ];

  expect(
    rows.sort(compareActorsByDefault).map((row) => row.canonicalEmail),
  ).toEqual(["new@test", "a@test", "b@test", "z@test"]);
});

test("actor identity helpers keep only non-canonical aliases", () => {
  const row = actor({
    aliases: [
      { email: "ada@test", line: null, name: "Ada Lovelace" },
      { email: "old@test", line: 2, name: "Ada" },
      { email: "old@test", line: 2, name: "Ada" },
    ],
    canonicalEmail: "ada@test",
    displayName: "Ada Lovelace",
  });

  expect(actorInitials(row)).toBe("AL");
  expect(visibleActorAliases(row)).toEqual([
    { email: "old@test", line: 2, name: "Ada" },
  ]);
});

test("heatmap expands sparse activity through an exclusive calendar boundary", () => {
  const activity: ActorActivitySnapshot = {
    availableYears: [2026],
    canonicalEmail: "ada@test",
    commitCount: 5,
    days: [
      { commitCount: 1, date: "2026-07-31" },
      { commitCount: 4, date: "2026-08-01" },
    ],
    generation: 2,
    rangeEndExclusive: "2026-08-02",
    rangeStart: "2026-07-30",
    repositoryId: "/repo",
    selectedYear: 2026,
    timeline: { day: null, months: [], nextCursor: null },
  };
  const cells = buildActorHeatmapCells(activity);
  const days = cells.filter((cell) => cell !== null);

  expect(days).toEqual([
    { commitCount: 0, date: "2026-07-30", level: 0 },
    { commitCount: 1, date: "2026-07-31", level: 1 },
    { commitCount: 4, date: "2026-08-01", level: 4 },
  ]);
  expect(cells.length % 7).toBe(0);
  expect(actorActivityEndDate(activity)).toBe("2026-08-01");
});

test("activity defaults to the current contribution year then the latest year", () => {
  expect(defaultActorActivityYear([2026, 2025], 2026)).toBe(2026);
  expect(defaultActorActivityYear([2025, 2024], 2026)).toBe(2025);
  expect(defaultActorActivityYear([], 2026)).toBe(2026);
});

test("activity continuation merges month previews without duplicating commits", () => {
  const base: ActorActivitySnapshot = {
    availableYears: [2026],
    canonicalEmail: "ada@test",
    commitCount: 6,
    days: [{ commitCount: 6, date: "2026-08-01" }],
    generation: 2,
    rangeEndExclusive: "2026-08-02",
    rangeStart: "2026-01-01",
    repositoryId: "actor-repo-test",
    selectedYear: 2026,
    timeline: {
      day: null,
      months: [
        {
          commitCount: 6,
          commits: [
            {
              authoredAt: 2,
              localDate: "2026-08-01",
              localTime: "12:00",
              shortSha: "bbbbbbb",
              subject: "Second",
            },
          ],
          month: "2026-08",
        },
      ],
      nextCursor: "next",
    },
  };
  const page: ActorActivitySnapshot = {
    ...base,
    timeline: {
      day: null,
      months: [
        {
          commitCount: 6,
          commits: [
            base.timeline.months[0]!.commits[0]!,
            {
              authoredAt: 1,
              localDate: "2026-08-01",
              localTime: "11:00",
              shortSha: "aaaaaaa",
              subject: "First",
            },
          ],
          month: "2026-08",
        },
      ],
      nextCursor: null,
    },
  };

  const merged = mergeActorActivityPage(base, page);
  expect(
    merged.timeline.months[0]?.commits.map((commit) => commit.subject),
  ).toEqual(["Second", "First"]);
  expect(merged.timeline.nextCursor).toBeNull();
});
