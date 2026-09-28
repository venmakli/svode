import { expect, test } from "bun:test";

import {
  registerRepositorySettingsOpener,
  repositoryOwner,
  repositorySettingsOpener,
} from "./repository-owner";

const context = {
  projectName: "Bigquest",
  projectPath: "/work/bigquest",
  spaces: [
    { name: "Compliance", path: "/work/bigquest/compliance" },
    { name: "Docs", path: "/work/bigquest/docs" },
  ],
};

test("a repository is named by the Project or Space that owns its location", () => {
  expect(repositoryOwner("/work/bigquest", context)).toEqual({
    displayName: "Bigquest",
    displayPath: "/work/bigquest",
    settingsPath: "/work/bigquest",
  });
  expect(repositoryOwner("/work/bigquest/compliance/", context)).toEqual({
    displayName: "Compliance",
    displayPath: "/work/bigquest/compliance/",
    settingsPath: "/work/bigquest/compliance",
  });
  expect(
    repositoryOwner("C:\\work\\bigquest\\compliance", {
      ...context,
      spaces: [
        { name: "Compliance", path: "C:\\work\\bigquest\\compliance\\" },
      ],
    }).displayName,
  ).toBe("Compliance");
});

test("a repository outside the project is named by its path and opens the project Git settings", () => {
  expect(repositoryOwner("/work/bigquest/vendor/lib", context)).toEqual({
    displayName: "lib",
    displayPath: "/work/bigquest/vendor/lib",
    settingsPath: "/work/bigquest",
  });
  expect(
    repositoryOwner("/elsewhere/repo", {
      projectName: null,
      projectPath: null,
      spaces: [],
    }),
  ).toEqual({
    displayName: "repo",
    displayPath: "/elsewhere/repo",
    settingsPath: null,
  });
});

test("Git settings open through the app shell opener that is registered at click time", () => {
  expect(repositorySettingsOpener("/work/bigquest")).toBe(undefined);
  const opened: string[] = [];
  const unregister = registerRepositorySettingsOpener((path) =>
    opened.push(path),
  );
  const open = repositorySettingsOpener("/work/bigquest/compliance");
  expect(repositorySettingsOpener(null)).toBe(undefined);
  open?.();
  expect(opened).toEqual(["/work/bigquest/compliance"]);
  unregister();
  expect(repositorySettingsOpener("/work/bigquest")).toBe(undefined);
});
