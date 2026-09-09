import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";

import {
  pageFilenameWarningFeedback,
  retargetPageFilenameWarnings,
} from "./filename-warning";

test("page filename feedback reports the actual projected path", () => {
  const feedback = pageFilenameWarningFeedback({
    kind: "filename_projection",
    message: "fallback",
    path: "日本語/Quarterly-Review.md",
  });

  expect(feedback?.description.includes("日本語/Quarterly-Review.md")).toBe(
    true,
  );
});

test("page filename feedback distinguishes allocated and unapplied collisions", () => {
  const allocated = pageFilenameWarningFeedback({
    kind: "filename_collision_allocated",
    message: "allocated",
    path: "Routine-1.md",
  });
  const unapplied = pageFilenameWarningFeedback({
    kind: "filename_rename_collision",
    message: "kept",
    path: "legacy.md",
  });

  expect(allocated?.description.includes("Routine-1.md")).toBe(true);
  expect(unapplied?.description.includes("legacy.md")).toBe(true);
  expect(allocated?.description === unapplied?.description).toBe(false);
});

test("page filename feedback keeps schema diagnostics and retry guidance in EN/RU", async () => {
  const originalLocale = getLocale();
  try {
    for (const locale of ["en", "ru"] as const) {
      await setLocale(locale, { reload: false });
      const warning = {
        kind: "filename_rename_deferred",
        message:
          "/Project/spaces/design/Tasks/schema.yaml: unknown variant checkbox",
        path: "legacy.md",
      };
      const feedback = pageFilenameWarningFeedback(warning);
      expect(feedback?.description.includes("legacy.md")).toBe(true);
      expect(feedback?.description.includes(warning.message)).toBe(true);
      expect(feedback?.description.includes("Enter")).toBe(true);
      expect(feedback?.title).toBe(
        locale === "en" ? "Filename kept" : "Имя файла не изменено",
      );
      expect(
        pageFilenameWarningFeedback({ ...warning, path: undefined })
          ?.description,
      ).toBe(warning.message);
    }
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("page filename feedback ignores unrelated diagnostics", () => {
  expect(
    pageFilenameWarningFeedback({
      kind: "malformed_frontmatter",
      message: "broken",
    }),
  ).toBeNull();
});

test("structural conversion retargets filename outcomes to the final path", () => {
  const warnings = retargetPageFilenameWarnings(
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
