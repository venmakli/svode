import { expect, test } from "bun:test";

import {
  entryFilenameWarningFeedback,
  retargetEntryFilenameWarnings,
} from "./filename-warning";

test("entry filename feedback reports the actual projected path", () => {
  const feedback = entryFilenameWarningFeedback({
    kind: "filename_projection",
    message: "fallback",
    path: "日本語/Quarterly-Review.md",
  });

  expect(feedback?.description.includes("日本語/Quarterly-Review.md")).toBe(
    true,
  );
});

test("entry filename feedback distinguishes allocated and unapplied collisions", () => {
  const allocated = entryFilenameWarningFeedback({
    kind: "filename_collision_allocated",
    message: "allocated",
    path: "Routine-1.md",
  });
  const unapplied = entryFilenameWarningFeedback({
    kind: "filename_rename_collision",
    message: "kept",
    path: "legacy.md",
  });

  expect(allocated?.description.includes("Routine-1.md")).toBe(true);
  expect(unapplied?.description.includes("legacy.md")).toBe(true);
  expect(allocated?.description === unapplied?.description).toBe(false);
});

test("entry filename feedback explains a safely deferred rename", () => {
  const feedback = entryFilenameWarningFeedback({
    kind: "filename_rename_deferred",
    message: "dependent metadata is invalid",
    path: "legacy.md",
  });

  expect(feedback?.description.includes("legacy.md")).toBe(true);
  expect(Boolean(feedback?.title.length)).toBe(true);
});

test("entry filename feedback ignores unrelated diagnostics", () => {
  expect(
    entryFilenameWarningFeedback({
      kind: "malformed_frontmatter",
      message: "broken",
    }),
  ).toBeNull();
});

test("structural conversion retargets filename outcomes to the final path", () => {
  const warnings = retargetEntryFilenameWarnings(
    [
      {
        kind: "filename_projection",
        message: "adjusted",
        path: "A-B.md",
      },
      { kind: "malformed_frontmatter", message: "broken" },
    ],
    "A-B/README.md",
  );

  expect(warnings?.[0]?.path).toBe("A-B/README.md");
  expect(warnings?.[1]?.path).toBe(undefined);
});
