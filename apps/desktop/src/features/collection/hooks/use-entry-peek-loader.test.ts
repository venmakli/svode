import { expect, test } from "bun:test";
import type { Entry } from "@/features/entry";
import type { EntryPeekTarget } from "../model";
import {
  entryPeekTargetKey,
  resolveLoadedPeekEntry,
} from "./use-entry-peek-loader";

test("a canonical rename does not reset the loaded peek entry to its stale target", () => {
  const initial = entry("Untitled.md", "Untitled");
  const renamed = entry("Renamed.md", "Renamed");
  const target: EntryPeekTarget = { entry: initial, nested: false };
  const targetKey = entryPeekTargetKey("/tmp/space", initial.path);

  expect(resolveLoadedPeekEntry(target, renamed, targetKey, targetKey)).toBe(
    renamed,
  );
});

test("a new peek target does not expose the previous target while loading", () => {
  const previous = entry("Previous.md", "Previous");
  const target: EntryPeekTarget = {
    entry: entry("Next.md", "Next"),
    nested: false,
  };

  expect(
    resolveLoadedPeekEntry(
      target,
      previous,
      entryPeekTargetKey("/tmp/space", previous.path),
      entryPeekTargetKey("/tmp/space", target.entry.path),
    ),
  ).toBeNull();
});

function entry(path: string, title: string): Entry {
  return {
    path,
    meta: {
      title,
      icon: null,
      created: "created",
      updated: "updated",
      extra: {},
    },
    body: "",
    warnings: [],
  };
}
