import { expect, test } from "bun:test";
import type { CustomAgentSetupDto } from "../api";
import {
  customAgentDefinition,
  customAgentDraft,
  customAgentRowView,
} from "./custom-agent";

function setup(
  overrides: Partial<CustomAgentSetupDto> = {},
): CustomAgentSetupDto {
  return {
    agent: "custom-hermes",
    name: "Hermes",
    command: "hermes",
    args: ["acp"],
    env: { HERMES_MODE: "acp" },
    enabled: true,
    executablePath: "/usr/local/bin/hermes",
    declared: null,
    restriction: null,
    ...overrides,
  };
}

test("a draft is one argument and one NAME=value per line, name and command required", () => {
  expect(
    customAgentDefinition({
      name: " Hermes ",
      command: " hermes ",
      args: "acp\n\n --verbose \n",
      env: "HERMES_MODE=acp\nURL=http://x?a=b\n",
    }),
  ).toEqual({
    definition: {
      name: "Hermes",
      command: "hermes",
      args: ["acp", "--verbose"],
      env: { HERMES_MODE: "acp", URL: "http://x?a=b" },
    },
    problem: null,
  });
  const draft = { name: "A", command: "a", args: "", env: "" };
  expect(customAgentDefinition({ ...draft, name: " " }).problem).toEqual({
    field: "name",
  });
  expect(customAgentDefinition({ ...draft, command: "" }).problem).toEqual({
    field: "command",
  });
  for (const line of ["no separator", "=value", "1KEY=x", "A B=x"])
    expect(customAgentDefinition({ ...draft, env: line }).problem).toEqual({
      field: "env",
      line,
    });
  // An edited agent opens with its definition.
  expect(customAgentDefinition(customAgentDraft(setup())).definition).toEqual({
    name: "Hermes",
    command: "hermes",
    args: ["acp"],
    env: { HERMES_MODE: "acp" },
  });
});

test("a custom row shows activity, then a missing command, then its restriction, then ready or off", () => {
  expect(customAgentRowView(setup(), null).state).toEqual({ kind: "ready" });
  expect(customAgentRowView(setup({ enabled: false }), null).state).toEqual({
    kind: "disabled",
  });
  expect(
    customAgentRowView(setup({ restriction: "new_session_only" }), null).state,
  ).toEqual({ kind: "limited", restriction: "new_session_only" });
  expect(
    customAgentRowView(
      setup({ executablePath: null, restriction: "new_session_only" }),
      null,
    ).state,
  ).toEqual({ kind: "command_missing", command: "hermes" });

  const capabilities = {
    loadSession: true,
    listSessions: true,
    resumeSession: false,
    closeSession: false,
  };
  const checked = customAgentRowView(setup({ executablePath: null }), {
    kind: "checked",
    result: {
      state: "ready",
      agent: { name: "hermes-agent", version: "unknown", capabilities },
    },
  });
  expect(checked.state).toEqual({
    kind: "checked",
    name: "hermes-agent",
    version: "unknown",
    declared: capabilities,
  });
  expect(checked.warning).toBeNull();
  expect(checked.action).toBeNull();

  const failed = customAgentRowView(setup(), {
    kind: "failed",
    operation: "remove_custom",
    error: { code: null, message: "denied" },
  });
  expect(failed.action).toBe("retry");
  // A custom agent has no sign-in command to run.
  const signIn = customAgentRowView(setup(), {
    kind: "checked",
    result: { state: "auth_required", message: "log in" },
  });
  expect(signIn.state).toEqual({ kind: "sign_in" });
  expect(signIn.action).toBeNull();
});
