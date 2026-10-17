import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type { RepositoryAccessBlocker } from "../model/repository-access";
import { repositoryBlockerNames } from "./repository-blocker-names";

const context = {
  projectName: "Bigquest",
  projectPath: "/work/bigquest",
  spaces: [
    { name: "Compliance", path: "/work/bigquest/compliance" },
    { name: "Design", path: "/work/bigquest/design" },
  ],
};

function blocker(
  repositoryPath: string,
  status: RepositoryAccessBlocker["status"] = "read_only",
  reason: RepositoryAccessBlocker["reason"] = "none",
): RepositoryAccessBlocker {
  return {
    repositoryId: `opaque-${repositoryPath}`,
    repositoryPath,
    status,
    reason,
  };
}

test("names each refusing repository by its owner", () => {
  const names = repositoryBlockerNames(
    [
      blocker("/work/bigquest/compliance"),
      blocker("/elsewhere/archive", "unknown", "not_checked"),
    ],
    context,
  );

  expect(names).toBe("Compliance, archive");
  expect(names.includes("opaque")).toBe(false);
});

test("names at most three repositories and counts the rest", async () => {
  const originalLocale = getLocale();
  try {
    for (const [locale, expected] of [
      ["en", "a, b, c and 2 more"],
      ["ru", "a, b, c и ещё 2"],
    ] as const) {
      await setLocale(locale, { reload: false });
      expect(
        repositoryBlockerNames(
          ["a", "b", "c", "d", "e"].map((name) => blocker(`/other/${name}`)),
          context,
        ),
      ).toBe(expected);
    }
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});
