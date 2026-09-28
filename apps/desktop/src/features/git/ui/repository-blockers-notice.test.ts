import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type { RepositoryAccessBlocker } from "../model/repository-access";
import { registerRepositorySettingsOpener } from "../model/repository-owner";
import { repositoryBlockersNotice } from "./repository-blockers-notice";

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

test("names each refusing repository by its owner and access state", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("ru", { reload: false });
    const notice = repositoryBlockersNotice(
      [
        blocker("/work/bigquest/compliance"),
        blocker("/elsewhere/archive", "unknown", "not_checked"),
      ],
      context,
    );

    expect(notice.repositories).toBe(
      "Compliance (Только чтение), archive (Доступ не подтверждён)",
    );
    expect(notice.repositories.includes("opaque")).toBe(false);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("names at most three repositories and counts the rest", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("en", { reload: false });
    const notice = repositoryBlockersNotice(
      ["a", "b", "c", "d", "e"].map((name) => blocker(`/other/${name}`)),
      context,
    );

    expect(notice.repositories).toBe(
      "a (Read only), b (Read only), c (Read only) and 2 more",
    );
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("opens the exact repository settings for one blocker and the project for several", () => {
  const opened: string[] = [];
  const unregister = registerRepositorySettingsOpener((path) =>
    opened.push(path),
  );
  try {
    repositoryBlockersNotice(
      [blocker("/work/bigquest/compliance")],
      context,
    ).settingsAction?.onClick();
    repositoryBlockersNotice(
      [blocker("/work/bigquest/compliance"), blocker("/work/bigquest/design")],
      context,
    ).settingsAction?.onClick();
  } finally {
    unregister();
  }

  expect(opened).toEqual(["/work/bigquest/compliance", "/work/bigquest"]);
});

test("offers no settings action while the app shell has no opener", () => {
  expect(
    repositoryBlockersNotice([blocker("/work/bigquest/compliance")], context)
      .settingsAction,
  ).toBe(undefined);
});
