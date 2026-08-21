import { expect, test } from "bun:test";

import { APP_SETTINGS_SECTION_KINDS } from "./app-settings-sections";

test("classifies App Settings surfaces without promoting derived state to preferences", () => {
  expect(APP_SETTINGS_SECTION_KINDS).toEqual({
    "git-identity": "owner-setting",
    appearance: "app-preference",
    "mcp-integrations": "owner-integration",
    "cli-agents": "command-derived",
    shortcuts: "read-only",
    about: "command-derived",
  });

  expect(
    Object.entries(APP_SETTINGS_SECTION_KINDS)
      .filter(([, kind]) => kind === "app-preference")
      .map(([section]) => section),
  ).toEqual(["appearance"]);
});
