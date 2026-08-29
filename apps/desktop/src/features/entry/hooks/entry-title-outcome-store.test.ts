import { expect, test } from "bun:test";
import type { Entry } from "../model";
import { useEntryTitleOutcomeStore } from "./entry-title-outcome-store";

test("title outcomes remain available to every consumer and chain by path", () => {
  useEntryTitleOutcomeStore.setState({ titleOutcomeBySourceKey: {} });
  const first: Entry = {
    path: "Renamed.md",
    meta: {
      title: "Renamed",
      icon: null,
      created: "created",
      updated: "updated",
      extra: {},
    },
    body: "",
    warnings: [],
  };
  useEntryTitleOutcomeStore
    .getState()
    .publishTitleOutcome("/tmp/space", "Untitled.md", first);

  const firstOutcome =
    useEntryTitleOutcomeStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Untitled.md"
    ];
  expect(firstOutcome?.entry).toBe(first);

  const second = {
    ...first,
    path: "Final.md",
    meta: { ...first.meta, title: "Final" },
  };
  useEntryTitleOutcomeStore
    .getState()
    .publishTitleOutcome("/tmp/space", "Renamed.md", second);

  expect(
    useEntryTitleOutcomeStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Renamed.md"
    ]?.entry,
  ).toBe(second);
});
