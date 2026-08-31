import { expect, test } from "bun:test";
import type { Page } from "@/features/page";
import type { PagePeekTarget } from "../model";
import {
  pagePeekTargetKey,
  resolveLoadedPeekPage,
} from "./use-page-peek-loader";

test("a canonical rename does not reset the loaded peek page to its stale target", () => {
  const initial = page("Untitled.md", "Untitled");
  const renamed = page("Renamed.md", "Renamed");
  const target: PagePeekTarget = { page: initial, nested: false };
  const targetKey = pagePeekTargetKey("/tmp/space", initial.path);

  expect(resolveLoadedPeekPage(target, renamed, targetKey, targetKey)).toBe(
    renamed,
  );
});

test("a new peek target does not expose the previous target while loading", () => {
  const previous = page("Previous.md", "Previous");
  const target: PagePeekTarget = {
    page: page("Next.md", "Next"),
    nested: false,
  };

  expect(
    resolveLoadedPeekPage(
      target,
      previous,
      pagePeekTargetKey("/tmp/space", previous.path),
      pagePeekTargetKey("/tmp/space", target.page.path),
    ),
  ).toBeNull();
});

function page(path: string, title: string): Page {
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
