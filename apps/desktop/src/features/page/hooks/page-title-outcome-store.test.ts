import { expect, test } from "bun:test";
import type { Page } from "../model";
import { usePageTitleOutcomeStore } from "./page-title-outcome-store";

test("title outcomes remain available to every consumer and chain by path", () => {
  usePageTitleOutcomeStore.setState({ titleOutcomeBySourceKey: {} });
  const first: Page = {
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
  usePageTitleOutcomeStore
    .getState()
    .publishTitleOutcome("/tmp/space", "Untitled.md", first);

  const firstOutcome =
    usePageTitleOutcomeStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Untitled.md"
    ];
  expect(firstOutcome?.page).toBe(first);

  const second = {
    ...first,
    path: "Final.md",
    meta: { ...first.meta, title: "Final" },
  };
  usePageTitleOutcomeStore
    .getState()
    .publishTitleOutcome("/tmp/space", "Renamed.md", second);

  expect(
    usePageTitleOutcomeStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Renamed.md"
    ]?.page,
  ).toBe(second);
});
