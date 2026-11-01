import { expect, test } from "bun:test";

import {
  areAgentActorDraftsEqual,
  compareAgentActorsByDefault,
  createAgentActorDraft,
  firstInvalidAgentActorCreateStep,
  resolveAgentActorRuntimeStatus,
  validateAgentActorDraft,
  withBindingAgent,
} from "./agent-actor-draft";
import type { AgentActorRow } from "./agent-actor-types";

const codexMode = { agent: "codex", setting: "mode", value: "agent" };

function row(name: string, inherited: boolean): AgentActorRow {
  return {
    actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
    binding: {
      agent: "codex",
      kind: "agent",
      settings: [{ setting: "model", value: "gpt-6.1-sol" }],
    },
    description: null,
    id: "01arz3ndektsv4rrffq69g5fav",
    inherited,
    mode: codexMode,
    name,
    ownerLabel: inherited ? "root" : "space",
    ownerPath: inherited ? "/repo" : "/repo/space",
    runtimeStatus: "unchecked",
  };
}

test("agent actor draft starts artifact-free with one default binding", () => {
  expect(createAgentActorDraft("/repo/space")).toEqual({
    binding: { agent: "codex", kind: "agent", settings: [] },
    description: "",
    id: null,
    mode: null,
    name: "",
    ownerPath: "/repo/space",
  });
});

test("an edit draft keeps the binding values and the device mode as they are", () => {
  const draft = createAgentActorDraft("/repo/space", row("Docs", false));
  expect(draft.binding).toEqual(row("Docs", false).binding);
  expect(draft.mode).toEqual(codexMode);
  expect(
    areAgentActorDraftsEqual(
      draft,
      createAgentActorDraft("/repo/space", row("Docs", false)),
    ),
  ).toBe(true);
});

test("changing the agent drops the values and the mode of the previous agent", () => {
  const draft = createAgentActorDraft("/repo/space", row("Docs", false));
  expect(withBindingAgent(draft, "codex")).toBe(draft);
  const claude = withBindingAgent(draft, "claude-code");
  expect(claude.binding).toEqual({
    agent: "claude-code",
    kind: "agent",
    settings: [],
  });
  expect(claude.mode).toBeNull();
  expect(areAgentActorDraftsEqual(draft, claude)).toBe(false);
});

test("agent actor draft requires a name", () => {
  const draft = createAgentActorDraft("/repo");
  draft.name = "  ";
  const validation = validateAgentActorDraft(draft);
  expect(validation).toEqual({ binding: null, name: "name_required" });
  expect(firstInvalidAgentActorCreateStep(validation)).toBe("identity");
  draft.name = "Docs";
  expect(validateAgentActorDraft(draft)).toEqual({
    binding: null,
    name: null,
  });
  expect(
    validateAgentActorDraft({ ...draft, binding: { kind: "participant" } })
      .binding,
  ).toBeNull();
});

test("runtime status follows the diagnostic of the binding's agent", () => {
  const binding = { agent: "codex", kind: "agent" as const, settings: [] };
  const ready = {
    adapter: "codex",
    authenticated: true,
    code: null,
    executablePath: "/bin/codex",
    message: null,
    status: "ready" as const,
    version: "1",
  };
  expect(
    resolveAgentActorRuntimeStatus({ binding, diagnostics: {}, known: true }),
  ).toBe("unchecked");
  expect(
    resolveAgentActorRuntimeStatus({
      binding,
      diagnostics: { codex: ready },
      known: true,
    }),
  ).toBe("ready");
  expect(
    resolveAgentActorRuntimeStatus({
      binding,
      diagnostics: { codex: { ...ready, status: "missing" } },
      known: true,
    }),
  ).toBe("attention");
  // An agent this version does not know needs another agent.
  expect(
    resolveAgentActorRuntimeStatus({ binding, diagnostics: {}, known: false }),
  ).toBe("attention");
  expect(
    resolveAgentActorRuntimeStatus({
      binding: { kind: "participant" },
      diagnostics: {},
      known: true,
    }),
  ).toBe("unchecked");
});

test("an agent found without a sign-in status command is ready", () => {
  const hermes = {
    adapter: "hermes",
    authenticated: null,
    code: "auth_status_unavailable",
    executablePath: "/bin/hermes",
    message: null,
    status: "unknown" as const,
    version: "2026.9.24",
  };
  const binding = { agent: "hermes", kind: "agent" as const, settings: [] };
  expect(
    resolveAgentActorRuntimeStatus({
      binding,
      diagnostics: { hermes },
      known: true,
    }),
  ).toBe("ready");
  expect(
    resolveAgentActorRuntimeStatus({
      binding,
      diagnostics: { hermes: { ...hermes, code: "version_failed" } },
      known: true,
    }),
  ).toBe("unchecked");
});

test("default order keeps own actors ahead of inherited actors", () => {
  expect(
    compareAgentActorsByDefault(row("Zed", false), row("Ada", true)) < 0,
  ).toBe(true);
});
