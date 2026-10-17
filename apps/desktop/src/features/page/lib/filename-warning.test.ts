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

test("a deferred rename for another cause is one line with the backend text in its details", async () => {
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
      expect(feedback?.title).toBe(
        locale === "en" ? "File not renamed" : "Файл не переименован",
      );
      expect(feedback?.description).toBe(
        locale === "en"
          ? "Couldn't verify rename dependencies."
          : "Не удалось проверить зависимости переименования.",
      );
      expect(feedback?.details).toEqual({
        path: "legacy.md",
        cause: { kind: "dependencies", message: warning.message },
      });
      expect(
        pageFilenameWarningFeedback({ ...warning, path: undefined })?.details
          ?.path,
      ).toBe(null);
    }
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("a deferred rename for access names the refusing repositories in one line", async () => {
  const originalLocale = getLocale();
  try {
    for (const locale of ["en", "ru"] as const) {
      await setLocale(locale, { reload: false });
      const blockers = ["compliance", "design", "archive", "ops"].map(
        (name) => ({
          repositoryId: `repo-opaque-${name}`,
          repositoryPath: `/work/bigquest/${name}`,
          status: "read_only" as const,
          reason: "none" as const,
        }),
      );
      const warning = {
        kind: "filename_rename_deferred",
        message: "technical: repo-opaque read_only none",
        path: "protsessy/README.md",
        reason: "repository_access_denied",
      };
      const one = pageFilenameWarningFeedback({
        ...warning,
        blockers: blockers.slice(0, 1),
      });
      const four = pageFilenameWarningFeedback({ ...warning, blockers });

      expect(one?.description).toBe(
        locale === "en"
          ? "No write access: compliance."
          : "Нет доступа на запись: compliance.",
      );
      expect(four?.description).toBe(
        locale === "en"
          ? "No write access: compliance, design, archive and 1 more."
          : "Нет доступа на запись: compliance, design, archive и ещё 1.",
      );
      expect(four?.details).toEqual({
        path: "protsessy/README.md",
        cause: { kind: "access", blockers },
      });
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
