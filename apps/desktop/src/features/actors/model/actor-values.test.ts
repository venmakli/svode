import { expect, test } from "bun:test";

import {
  actorActivityEndDate,
  actorInitials,
  buildActorHeatmapCells,
  compareActorsByDefault,
  visibleActorAliases,
} from "./actor-values";
import type { ActorActivitySnapshot, ActorCatalogRow } from "./types";

function actor(
  input: Partial<ActorCatalogRow> &
    Pick<ActorCatalogRow, "canonicalEmail" | "displayName">,
): ActorCatalogRow {
  return {
    aliases: [],
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
    canonicalEmail: "ada@test",
    days: [
      { commitCount: 1, date: "2026-07-31" },
      { commitCount: 4, date: "2026-08-01" },
    ],
    generation: 2,
    rangeEndExclusive: "2026-08-02",
    rangeStart: "2026-07-30",
    repositoryId: "/repo",
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
